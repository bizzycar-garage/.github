import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  bootstrapScriptBodies,
  commandNeedsRuby,
  ensureImpactedRuby,
  parseBundledWith,
  parseRequestedRuby,
  rubyDownloadUrls,
  type ShellRunner,
} from "./ruby-runtime.js";

const execFileAsync = promisify(execFile);

test("selects RSpec commands and ignores JS or echo skips", () => {
  assert.equal(commandNeedsRuby("bundle exec rspec spec/a_spec.rb spec/b_spec.rb --format documentation"), true);
  assert.equal(commandNeedsRuby("bin/rspec spec/models/ticket_spec.rb"), true);
  assert.equal(commandNeedsRuby('echo "no impacted specs"'), false);
  assert.equal(commandNeedsRuby("npm test -- src/banner.test.ts"), false);
});

test("reads .ruby-version and BUNDLED WITH", () => {
  assert.equal(parseRequestedRuby("3.3.6\n", undefined), "3.3.6");
  assert.equal(parseRequestedRuby("ruby-3.4.2\n", undefined), "3.4.2");
  assert.equal(parseRequestedRuby(undefined, "source 'https://rubygems.org'\nruby '3.3.6'\n"), "3.3.6");
  assert.equal(parseRequestedRuby("# comment\n", "ruby '~> 3.2'\n"), undefined);
  assert.equal(parseBundledWith("GEM\n  remote: https://rubygems.org/\n\nBUNDLED WITH\n   2.5.22\n"), "2.5.22");
});

test("ruby-builder URLs stay on the ruby-builder release path", () => {
  const urls = rubyDownloadUrls("3.3.6", "x64");
  assert.ok(urls.every((url) => url.startsWith("https://github.com/ruby/ruby-builder/releases/download/")));
  assert.ok(urls.some((url) => url.includes("ruby-3.3.6-ubuntu-22.04-x64.tar.gz")));
  assert.equal(rubyDownloadUrls("3.3", "x64").length, 0);
});

test("bootstrap scripts parse", async () => {
  for (const [step, body] of Object.entries(bootstrapScriptBodies)) {
    await execFileAsync("sh", ["-n", "-c", body], { timeout: 5_000 }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`${step} failed sh -n: ${message}`);
    });
  }
});

test("installs the pinned Ruby and Bundler before bundle install", async () => {
  const checkoutDir = await mkdtemp(join(tmpdir(), "mr-nexus-ruby-"));
  await writeFile(join(checkoutDir, ".ruby-version"), "3.3.6\n");
  await writeFile(join(checkoutDir, "Gemfile"), "source 'https://rubygems.org'\nruby '3.3.6'\n");
  await writeFile(join(checkoutDir, "Gemfile.lock"), "GEM\n  remote: https://rubygems.org/\n\nBUNDLED WITH\n   2.5.22\n");

  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_shouldnotleak";
  const steps: string[] = [];
  let probes = 0;
  const run: ShellRunner = async ({ step, env }) => {
    steps.push(step);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    if (step === "probe") {
      probes += 1;
      if (probes === 1) return { exitCode: 0, log: "", durationMs: 1 };
      if (!env.PATH?.includes("prebuilt")) return { exitCode: 0, log: "", durationMs: 1 };
      const bundle = env.PATH?.includes("gem-bin")
        ? "MR_NEXUS_BUNDLE_VERSION=2.5.22\n"
        : "";
      return {
        exitCode: 0,
        log: `MR_NEXUS_RUBY_BIN=/opt/prebuilt/bin\nMR_NEXUS_RUBY_VERSION=3.3.6\n${bundle}`,
        durationMs: 1,
      };
    }
    if (step === "prebuilt-ruby") {
      assert.match(env.MR_NEXUS_RUBY_URLS ?? "", /ruby-3\.3\.6-ubuntu-22\.04-/);
      assert.equal(env.MR_NEXUS_RUBY_VERSION, "3.3.6");
      return {
        exitCode: 0,
        log: "MR_NEXUS_RUBY_BIN=/opt/prebuilt/bin\nMR_NEXUS_RUBY_VERSION=3.3.6\n",
        durationMs: 4,
      };
    }
    if (step === "gem-bundler") {
      assert.equal(env.MR_NEXUS_BUNDLER_VERSION, "2.5.22");
      assert.match(env.PATH ?? "", /prebuilt/);
      return {
        exitCode: 0,
        log: "Bundler version 2.5.22\nMR_NEXUS_GEM_BIN=/opt/gem-bin\n",
        durationMs: 4,
      };
    }
    if (step === "bundle-install") {
      assert.match(env.PATH ?? "", /gem-bin/);
      assert.equal(env.BUNDLE_PATH, join(checkoutDir, "vendor/bundle"));
      return { exitCode: 0, log: "Bundle complete!\n", durationMs: 4 };
    }
    return { exitCode: 0, log: `${step} ok\n`, durationMs: 1 };
  };

  try {
    const result = await ensureImpactedRuby({
      checkoutDir,
      commands: ["bundle exec rspec spec/models/communication_ticket_spec.rb --format documentation"],
      run,
    });
    assert.equal(result.ok, true);
    if (!result.ok || result.skipped) return;
    assert.match(result.note, /installed ruby 3\.3\.6, bundler 2\.5\.22; bundle install ok/);
    assert.match(result.env.PATH ?? "", /gem-bin/);
    assert.deepEqual(steps, ["probe", "apt-packages", "probe", "prebuilt-ruby", "probe", "gem-bundler", "probe", "bundle-install", "probe"]);
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
});

test("skips bootstrap for non-ruby commands and reports a failed ruby download", async () => {
  const checkoutDir = await mkdtemp(join(tmpdir(), "mr-nexus-ruby-skip-"));
  await writeFile(join(checkoutDir, ".ruby-version"), "3.3.6\n");
  const skipped = await ensureImpactedRuby({
    checkoutDir,
    commands: ['echo "no impacted specs"'],
    run: async () => {
      throw new Error("runner should not be called");
    },
  });
  assert.deepEqual(skipped, { ok: true, skipped: true });

  const failed = await ensureImpactedRuby({
    checkoutDir,
    commands: ["bundle exec rspec spec/a_spec.rb"],
    run: async ({ step }) => {
      if (step === "probe") return { exitCode: 0, log: "", durationMs: 1 };
      if (step === "prebuilt-ruby") {
        return { exitCode: 1, log: "prebuilt ruby download failed for 3.3.6\n", durationMs: 5 };
      }
      return { exitCode: 0, log: "", durationMs: 1 };
    },
  });
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.exitCode, 1);
  assert.match(failed.note, /could not install ruby 3\.3\.6/);
  assert.match(failed.logTail, /download failed/);
});

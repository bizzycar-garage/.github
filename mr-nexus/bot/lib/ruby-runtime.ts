import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./checkout.js";

const TOKEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HIVE_GIT_READ_TOKEN",
  "SHALLOW_CLONE_GIT_TOKEN",
  "SHALLOW_CLONE_GIT_USERNAME",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "CURSOR_API_KEY",
  "CURSOR_SERVICE_ACCOUNT_KEY",
];

const VERSION = /^(\d+\.\d+\.\d+)$/;
const RUBY_TOOL = /(?:^|[/\s;&|`(])(bundle|rspec|rails|rake)(?=$|[\s;&|`])/;

const PROBE_SH = `
ruby_bin=$(command -v ruby 2>/dev/null || true)
bundle_bin=$(command -v bundle 2>/dev/null || true)
if [ -n "$ruby_bin" ]; then
  echo "MR_NEXUS_RUBY_BIN=$(dirname "$ruby_bin")"
  "$ruby_bin" -e 'print "MR_NEXUS_RUBY_VERSION=#{RUBY_VERSION}\\n"'
fi
if [ -n "$bundle_bin" ]; then
  ver=$("$bundle_bin" -v 2>/dev/null | awk 'NR==1 { print $NF }' || true)
  if [ -n "$ver" ]; then
    echo "MR_NEXUS_BUNDLE_VERSION=$ver"
  fi
fi
exit 0
`;

const APT_SH = `
set -eu
export DEBIAN_FRONTEND=noninteractive
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
  else
    echo "not root and sudo -n is unavailable" >&2
    return 1
  fi
}
if command -v apt-get >/dev/null 2>&1; then
  run_root apt-get update -y
  run_root apt-get install -y ca-certificates curl build-essential libffi-dev libyaml-dev zlib1g-dev libssl-dev libreadline-dev libpq-dev ruby ruby-dev
  run_root apt-get install -y ruby-bundler || true
elif command -v apk >/dev/null 2>&1; then
  run_root apk add --no-cache ca-certificates curl build-base ruby ruby-dev ruby-bundler
else
  echo "no apt-get or apk; skipped system packages" >&2
  exit 0
fi
`;

const PREBUILT_SH = `
set -eu
version=\${MR_NEXUS_RUBY_VERSION:?}
prefix=\${MR_NEXUS_RUBY_PREFIX:?}
mkdir -p "$prefix"
pick_bin() {
  if [ -x "$prefix/bin/ruby" ]; then
    echo "$prefix/bin"
  elif [ -x "$prefix/x64/bin/ruby" ]; then
    echo "$prefix/x64/bin"
  elif [ -x "$prefix/arm64/bin/ruby" ]; then
    echo "$prefix/arm64/bin"
  fi
}
bin=$(pick_bin || true)
if [ -z "$bin" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  found=0
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    case "$url" in
      https://github.com/ruby/ruby-builder/releases/download/*) ;;
      *) continue ;;
    esac
    if curl -fsSL --retry 2 --max-time 90 "$url" -o "$tmp/ruby.tar.gz"; then
      found=1
      break
    fi
  done <<EOF
\${MR_NEXUS_RUBY_URLS:-}
EOF
  if [ "$found" -ne 1 ]; then
    echo "prebuilt ruby download failed for $version" >&2
    exit 1
  fi
  tar -xzf "$tmp/ruby.tar.gz" -C "$prefix"
  bin=$(pick_bin || true)
fi
if [ -z "$bin" ]; then
  echo "prebuilt archive had no bin/ruby under $prefix" >&2
  exit 1
fi
actual=$("$bin/ruby" -e 'print RUBY_VERSION')
echo "MR_NEXUS_RUBY_BIN=$bin"
echo "MR_NEXUS_RUBY_VERSION=$actual"
if [ "$actual" != "$version" ]; then
  echo "extracted ruby $actual does not match $version" >&2
  exit 1
fi
`;

const GEM_SH = `
set -eu
if [ -n "\${MR_NEXUS_BUNDLER_VERSION:-}" ]; then
  gem install bundler -v "$MR_NEXUS_BUNDLER_VERSION" --no-document
else
  gem install bundler --no-document
fi
bundle -v
ruby -e 'print "MR_NEXUS_GEM_BIN=#{Gem.bindir}\\n"'
`;

const BUNDLE_CHECK_SH = `
bundle check
`;

const BUNDLE_INSTALL_SH = `
set -eu
bundle install --jobs "\${BUNDLE_JOBS:-2}" --retry "\${BUNDLE_RETRY:-3}"
`;

export type ShellResult = {
  exitCode: number | null;
  log: string;
  durationMs: number;
};

export type ShellRunner = (input: {
  step: string;
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<ShellResult>;

export type RubyBootstrap =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; note: string; env: NodeJS.ProcessEnv; logTail: string }
  | { ok: false; note: string; exitCode: number | null; durationMs: number; logTail: string };

type Probe = { ruby?: string; bundle?: string; bin?: string };

export function commandNeedsRuby(command: string): boolean {
  return RUBY_TOOL.test(command);
}

export function parseRequestedRuby(
  rubyVersionFile: string | undefined,
  gemfile: string | undefined,
): string | undefined {
  const line = rubyVersionFile
    ?.split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#"));
  const fromFile = line?.replace(/^ruby-/, "");
  if (fromFile && VERSION.test(fromFile)) return fromFile;
  const fromGemfile = gemfile?.match(/^\s*ruby\s+['"](\d+\.\d+\.\d+)['"]/m)?.[1];
  return fromGemfile && VERSION.test(fromGemfile) ? fromGemfile : undefined;
}

export function parseBundledWith(lockfile: string | undefined): string | undefined {
  const version = lockfile?.match(/^BUNDLED WITH\r?\n\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
  return version && VERSION.test(version) ? version : undefined;
}

export function rubyDownloadUrls(version: string, arch: string): string[] {
  if (!VERSION.test(version)) return [];
  const platform = arch === "arm64" ? "arm64" : "x64";
  const modern = [
    `https://github.com/ruby/ruby-builder/releases/download/ruby-${version}/ruby-${version}-ubuntu-22.04-${platform}.tar.gz`,
    `https://github.com/ruby/ruby-builder/releases/download/ruby-${version}/ruby-${version}-ubuntu-24.04-${platform}.tar.gz`,
  ];
  const legacy =
    platform === "x64"
      ? [
          `https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-${version}-ubuntu-22.04.tar.gz`,
          `https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-${version}-ubuntu-24.04.tar.gz`,
        ]
      : [
          `https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-${version}-ubuntu-22.04-arm64.tar.gz`,
          `https://github.com/ruby/ruby-builder/releases/download/toolcache/ruby-${version}-ubuntu-24.04-arm64.tar.gz`,
        ];
  return [...modern, ...legacy];
}

function marker(log: string, key: string): string | undefined {
  const matches = [...log.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
  const value = matches.at(-1)?.[1]?.trim();
  return value ? value : undefined;
}

function parseProbe(log: string): Probe {
  return {
    ruby: marker(log, "MR_NEXUS_RUBY_VERSION"),
    bundle: marker(log, "MR_NEXUS_BUNDLE_VERSION"),
    bin: marker(log, "MR_NEXUS_RUBY_BIN"),
  };
}

function versionOk(installed: string | undefined, requested: string | undefined): boolean {
  if (!installed) return false;
  if (!requested) return true;
  return installed === requested;
}

function safeEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of TOKEN_ENV) delete env[key];
  if (!env.PATH) {
    env.PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  }
  return env;
}

function withPath(env: NodeJS.ProcessEnv, binDir: string | undefined): NodeJS.ProcessEnv {
  if (!binDir) return env;
  const current = env.PATH ?? "";
  if (current.split(":").includes(binDir)) return env;
  return { ...env, PATH: `${binDir}:${current}` };
}

function tail(parts: string[]): string {
  return redactSecrets(parts.filter((item) => item.trim()).join("\n")).slice(-4000);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultRunner(): ShellRunner {
  return async ({ script, cwd, env, timeoutMs }) => {
    const started = Date.now();
    return await new Promise((resolve) => {
      const child = spawn("sh", ["-c", script], { cwd, env, shell: false });
      let log = "";
      const onData = (chunk: Buffer) => {
        log = (log + chunk.toString("utf8")).slice(-8000);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, log: redactSecrets(log), durationMs: Date.now() - started });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          log: redactSecrets(String(error)),
          durationMs: Date.now() - started,
        });
      });
    });
  };
}

function script(step: string, body: string): string {
  return `# mr-nexus-step:${step}\n${body}`;
}

export async function ensureImpactedRuby(input: {
  checkoutDir: string;
  commands: readonly string[];
  run?: ShellRunner;
}): Promise<RubyBootstrap> {
  if (!input.commands.some((command) => commandNeedsRuby(command))) {
    return { ok: true, skipped: true };
  }

  const started = Date.now();
  const logs: string[] = [];
  const run = input.run ?? defaultRunner();
  let env = safeEnv({});
  let installed = false;

  const fail = (note: string, exitCode: number | null): RubyBootstrap => ({
    ok: false,
    note,
    exitCode,
    durationMs: Date.now() - started,
    logTail: tail(logs),
  });

  const exec = async (
    step: string,
    body: string,
    timeoutMs: number,
    stepEnv: NodeJS.ProcessEnv = env,
  ): Promise<ShellResult> => {
    const result = await run({
      step,
      script: script(step, body),
      cwd: input.checkoutDir,
      env: stepEnv,
      timeoutMs,
    });
    logs.push(result.log);
    return result;
  };

  const gemfile = await readOptional(join(input.checkoutDir, "Gemfile"));
  const lockfile = await readOptional(join(input.checkoutDir, "Gemfile.lock"));
  const rubyVersionFile = await readOptional(join(input.checkoutDir, ".ruby-version"));
  const requestedRuby = parseRequestedRuby(rubyVersionFile, gemfile);
  const requestedBundler = parseBundledWith(lockfile);
  const hasGemfile = gemfile !== undefined;
  const vendor = join(input.checkoutDir, "vendor/bundle");

  let probe = parseProbe((await exec("probe", PROBE_SH, 20_000)).log);
  if (probe.bin) env = withPath(env, probe.bin);

  const rubyReady = versionOk(probe.ruby, requestedRuby);
  const bundleReady = versionOk(probe.bundle, requestedBundler);
  if (rubyReady && bundleReady && !hasGemfile) {
    return ready(probe, false, "no Gemfile; skipped bundle install", env);
  }
  if (rubyReady && bundleReady && hasGemfile) {
    const systemCheck = await exec("bundle-check", BUNDLE_CHECK_SH, 60_000, env);
    if (systemCheck.exitCode === 0) {
      return ready(probe, false, "gems already installed", env);
    }
    const vendored = { ...env, BUNDLE_PATH: vendor, BUNDLE_JOBS: "2", BUNDLE_RETRY: "3" };
    const localCheck = await exec("bundle-check", BUNDLE_CHECK_SH, 60_000, vendored);
    if (localCheck.exitCode === 0) {
      return ready(probe, false, "gems already installed", vendored);
    }
  }

  const apt = await exec("apt-packages", APT_SH, 240_000);
  probe = parseProbe((await exec("probe", PROBE_SH, 20_000, env)).log);
  if (probe.bin) env = withPath(env, probe.bin);
  if (!rubyReady && probe.ruby && versionOk(probe.ruby, requestedRuby)) {
    installed = true;
  }

  if (requestedRuby && !versionOk(probe.ruby, requestedRuby)) {
    const prefix = join(homedir(), ".mr-nexus", "ruby", requestedRuby);
    const preEnv = safeEnv({
      ...env,
      MR_NEXUS_RUBY_VERSION: requestedRuby,
      MR_NEXUS_RUBY_PREFIX: prefix,
      MR_NEXUS_RUBY_URLS: rubyDownloadUrls(requestedRuby, process.arch).join("\n"),
    });
    const prebuilt = await exec("prebuilt-ruby", PREBUILT_SH, 240_000, preEnv);
    if (prebuilt.exitCode !== 0) {
      return fail(`could not install ruby ${requestedRuby}`, prebuilt.exitCode ?? 127);
    }
    const parsed = parseProbe(prebuilt.log);
    env = withPath(env, parsed.bin);
    installed = true;
    probe = parseProbe((await exec("probe", PROBE_SH, 20_000, env)).log);
    if (!versionOk(probe.ruby, requestedRuby)) {
      return fail(`ruby ${requestedRuby} is not on PATH after install`, 127);
    }
  } else if (!probe.ruby) {
    if (apt.exitCode !== 0) {
      return fail("could not install ruby (no apt/apk package and no .ruby-version pin)", apt.exitCode ?? 127);
    }
    return fail("ruby is still missing after the package install", 127);
  }

  if (!versionOk(probe.bundle, requestedBundler)) {
    const gemEnv = safeEnv({ ...env });
    if (requestedBundler) gemEnv.MR_NEXUS_BUNDLER_VERSION = requestedBundler;
    const gem = await exec("gem-bundler", GEM_SH, 180_000, gemEnv);
    if (gem.exitCode !== 0) {
      return fail(
        requestedBundler ? `could not install bundler ${requestedBundler}` : "could not install bundler",
        gem.exitCode ?? 127,
      );
    }
    env = withPath(env, marker(gem.log, "MR_NEXUS_GEM_BIN"));
    installed = true;
    probe = parseProbe((await exec("probe", PROBE_SH, 20_000, env)).log);
    if (!probe.bundle) return fail("bundle is still missing after gem install", 127);
  }

  if (!hasGemfile) {
    return ready(probe, installed, "no Gemfile; skipped bundle install", env);
  }

  const bundleEnv = safeEnv({
    ...env,
    BUNDLE_PATH: vendor,
    BUNDLE_JOBS: "2",
    BUNDLE_RETRY: "3",
  });
  const installedGems = await exec("bundle-install", BUNDLE_INSTALL_SH, 540_000, bundleEnv);
  if (installedGems.exitCode !== 0) {
    return fail("bundle install failed", installedGems.exitCode ?? 1);
  }
  probe = parseProbe((await exec("probe", PROBE_SH, 20_000, bundleEnv)).log);
  return ready(probe, installed, "bundle install ok", bundleEnv);

  function ready(
    current: Probe,
    didInstall: boolean,
    gems: string,
    nextEnv: NodeJS.ProcessEnv,
  ): RubyBootstrap {
    const ruby = current.ruby ?? "unknown";
    const bundler = current.bundle ?? "unknown";
    const how = didInstall ? "installed " : "";
    return {
      ok: true,
      skipped: false,
      note: `${how}ruby ${ruby}, bundler ${bundler}; ${gems}`,
      env: nextEnv,
      logTail: tail(logs),
    };
  }
}

export const bootstrapScriptBodies = {
  probe: PROBE_SH,
  "apt-packages": APT_SH,
  "prebuilt-ruby": PREBUILT_SH,
  "gem-bundler": GEM_SH,
  "bundle-check": BUNDLE_CHECK_SH,
  "bundle-install": BUNDLE_INSTALL_SH,
} as const;

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <version-tag> <sha256> [repo]" >&2
  echo "Example: $0 v0.2.0 0123abcd... cola-runner/session-hub" >&2
  exit 1
fi

version_tag="$1"
sha256_value="$2"
repo="${3:-cola-runner/session-hub}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
formula_path="$project_root/packaging/homebrew/session-hub.rb"

cat > "$formula_path" <<FORMULA
class SessionHub < Formula
  desc "Local batch manager for CLI conversation history"
  homepage "https://github.com/${repo}"
  url "https://github.com/${repo}/archive/refs/tags/${version_tag}.tar.gz"
  sha256 "${sha256_value}"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]

    (bin/"session-hub").write <<~SH
      #!/usr/bin/env bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/src/cli.js" "$@"
    SH
  end

  test do
    assert_match "session-hub", shell_output("#{bin}/session-hub --help")
  end
end
FORMULA

echo "Wrote formula to: $formula_path"

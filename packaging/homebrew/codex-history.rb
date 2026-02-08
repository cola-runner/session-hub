class CodexHistory < Formula
  desc "Local batch manager for Codex conversation history"
  homepage "https://github.com/cola-runner/session-hub"
  url "https://github.com/cola-runner/session-hub/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]

    (bin/"codex-history").write <<~SH
      #!/usr/bin/env bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/src/cli.js" "$@"
    SH
  end

  test do
    assert_match "codex-history", shell_output("#{bin}/codex-history --help")
  end
end

class SessionHub < Formula
  desc "Local batch manager for CLI conversation history"
  homepage "https://github.com/cola-runner/session-hub"
  url "https://github.com/cola-runner/session-hub/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
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

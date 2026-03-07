class SessionHub < Formula
  desc "Local batch manager for CLI conversation history"
  homepage "https://github.com/cola-runner/session-hub"
  url "https://github.com/cola-runner/session-hub/archive/refs/tags/v0.2.1.tar.gz"
  sha256 "533062ac4bd4e37cbb5bd1dc1fe15182c4a0cba51e78f8a53aace1540943c796"
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

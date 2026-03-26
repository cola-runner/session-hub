class SessionHub < Formula
  desc "Local batch manager for CLI conversation history"
  homepage "https://github.com/cola-runner/session-hub"
  url "https://github.com/cola-runner/session-hub/archive/refs/tags/v0.2.2.tar.gz"
  sha256 "9cd43c91b503c79f9e31d69500f0b7f2ed668de3f9c5ea73a9b17b4a454efe4d"
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

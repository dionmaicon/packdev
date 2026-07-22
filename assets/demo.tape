# PackDev demo — rendered with VHS (https://github.com/charmbracelet/vhs)
#
#   Regenerate:  vhs assets/demo.tape      (writes assets/demo.gif)
#
# Requires: vhs, ttyd, ffmpeg, and a build of packdev (npm run build). The tape
# points `packdev` at the local dist build so it runs without publishing.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# --- Setup (hidden): scratch app + a local library, packdev on PATH ----------
Hidden
Type "REPO=$PWD; packdev() { node $REPO/dist/index.js \"$@\"; }" Enter
Type "cd $(mktemp -d)" Enter
Type "printf '{\"name\":\"app\",\"version\":\"1.0.0\",\"dependencies\":{\"my-lib\":\"^1.0.0\"}}' > package.json" Enter
Type "echo '{}' > package-lock.json" Enter
Type "mkdir my-lib && printf '{\"name\":\"my-lib\",\"version\":\"1.0.0\"}' > my-lib/package.json" Enter
Type "clear" Enter
Show

# --- Demo ---------------------------------------------------------------------
# --no-install keeps the demo fast and offline; drop it to show the real
# npm/yarn/pnpm install step.
Type "# Point a dependency at your local checkout — no npm link, no global state" Enter
Sleep 800ms
Type "packdev add my-lib ./my-lib --no-install" Enter
Sleep 2s

# add already flips package.json; reset it so `init` shows the swap it performs.
Hidden
Type "printf '{\"name\":\"app\",\"version\":\"1.0.0\",\"dependencies\":{\"my-lib\":\"^1.0.0\"}}' > package.json" Enter
Show

Type "packdev init --no-install" Enter
Sleep 2s

Type "# Check which mode you're in" Enter
Sleep 500ms
Type "packdev status" Enter
Sleep 2500ms

Type "# Done developing? Restore the published version in one command" Enter
Sleep 800ms
Type "packdev finish --no-install" Enter
Sleep 2500ms

Type "# Clean package.json, ready to commit." Enter
Sleep 2s

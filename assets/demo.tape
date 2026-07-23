# PackDev demo — rendered with VHS (https://github.com/charmbracelet/vhs)
#
#   Regenerate:  npm run build && vhs assets/demo.tape   (writes assets/demo.gif)
#
# Project setup lives in assets/demo-setup.sh so this tape stays free of the
# escaped quotes / JSON that VHS's Type parser can't handle.

Output assets/demo.gif

Set Shell "bash"
Set FontSize 20
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Dracula"
Set PlaybackSpeed 1.0

# --- Setup: scratch app + local lib + `packdev` wrapper on PATH ---------------
# Typed instantly and cleared so it does not appear in the recording.
Set TypingSpeed 0ms
Type "D=$(bash assets/demo-setup.sh $PWD); cd $D; export PATH=$D/bin:$PATH; clear" Enter
Sleep 500ms
Set TypingSpeed 60ms

# --- Demo ---------------------------------------------------------------------
# --no-install keeps the demo fast and offline; drop it to show the real
# npm/yarn/pnpm install step.
Type "# Point a dependency at your local checkout - no npm link, no global state" Enter
Sleep 800ms
Type "packdev add my-lib ./my-lib --no-install" Enter
Sleep 2500ms

Type "# You are now in development mode - check it" Enter
Sleep 500ms
Type "packdev status" Enter
Sleep 3s

Type "# Done? Restore the published version in one command" Enter
Sleep 800ms
Type "packdev finish --no-install" Enter
Sleep 2500ms

Type "# Clean package.json, ready to commit." Enter
Sleep 2500ms

# 🎨 Assets Directory

This directory contains static assets for the PackDev documentation site.

## 🎬 Terminal demo (`demo.gif`)

`demo.gif` is the terminal demo in the top-level README. It is generated from
`demo.tape` with [VHS](https://github.com/charmbracelet/vhs) — a scripted,
reproducible terminal recorder — so it can be regenerated deterministically
instead of screen-recorded.

**Regenerate** (needs `vhs`, `ttyd`, and `ffmpeg` on PATH):

```bash
# Install VHS — https://github.com/charmbracelet/vhs#installation
#   macOS:  brew install vhs
#   Go:     go install github.com/charmbracelet/vhs@latest

npm run build          # the tape runs the local dist build of packdev
vhs assets/demo.tape   # writes assets/demo.gif
```

Edit `demo.tape` to change commands, timing, theme, or size. It points `packdev`
at `dist/index.js` (no global install or publish needed) and uses `--no-install`
to stay fast and offline; drop that flag to show the real install step.

## 📁 Required Assets

### Favicon Files
- `favicon.ico` - Main favicon (16x16, 32x32, 48x48)
- `apple-touch-icon.png` - Apple touch icon (180x180)
- `android-chrome-192x192.png` - Android icon (192x192)
- `android-chrome-512x512.png` - Android icon (512x512)

### Social Sharing Images
- `packdev-og-image.png` - Open Graph image (1200x630)
- `packdev-twitter-card.png` - Twitter card image (1200x600)

### Logo Files
- `logo.svg` - Vector logo (scalable)
- `logo.png` - PNG logo (256x256 recommended)
- `logo-white.svg` - White version for dark backgrounds

### Screenshots/Examples
- `demo-screenshot.png` - Product demo screenshot
- `workflow-diagram.svg` - Workflow visualization
- `feature-preview.png` - Feature showcase images

## 🛠️ Asset Guidelines

### Favicon Requirements
```bash
# Generate favicon package at https://realfavicongenerator.net/
# Upload your logo and download the package
# Extract files to this directory
```

### Image Specifications

| Asset Type | Dimensions | Format | Notes |
|------------|------------|--------|-------|
| Open Graph | 1200x630 | PNG/JPG | For social sharing |
| Twitter Card | 1200x600 | PNG/JPG | Twitter-optimized |
| Logo | 256x256+ | SVG/PNG | Vector preferred |
| Screenshots | 1920x1080 | PNG | High-resolution demos |

### Optimization
- Compress images using tools like TinyPNG
- Use WebP format when possible
- Provide fallbacks for older browsers
- Keep file sizes under 500KB for fast loading

## 📝 Adding New Assets

1. **Place files in this directory**
2. **Update references in:**
   - `index.html` (favicon, og:image)
   - `README.md` (screenshots, logos)
   - Custom CSS (background images)

3. **Test loading:**
```bash
# Serve locally and check console for 404s
npx docsify serve . --port 3000
```

## 🎨 Creating Assets

### Logo Design Tips
- Use your brand colors
- Ensure scalability (SVG preferred)
- Test on both light and dark backgrounds
- Keep it simple for favicon sizes

### Social Card Template
```
PackDev - Package Development Manager
[Your Logo]
Test npm packages using local paths or git repos before publishing
Stop struggling with npm link forever!
```

### Screenshot Guidelines
- Use consistent browser/OS styling
- Highlight key features
- Include relevant code examples
- Show before/after comparisons

## 🔗 Asset URLs

When deployed, assets will be available at:
```
https://dionmaicon.github.io/packdev/assets/filename.ext
```

Update the placeholder URLs in `index.html` with your actual repository information.

## 📋 Asset Checklist

Before deployment, ensure you have:
- [ ] favicon.ico
- [ ] apple-touch-icon.png
- [ ] packdev-og-image.png (social sharing)
- [ ] logo files (SVG + PNG)
- [ ] demo screenshots
- [ ] All images optimized
- [ ] References updated in HTML/CSS

## 🎯 Quick Setup

If you don't have assets yet, you can:

1. **Use text-based placeholders** (already configured)
2. **Generate a simple logo** using tools like:
   - Canva
   - Figma
   - Logo generators
3. **Take screenshots** of your CLI in action
4. **Create social cards** using templates

The site will work without custom assets, but adding them greatly improves the professional appearance and social sharing experience.

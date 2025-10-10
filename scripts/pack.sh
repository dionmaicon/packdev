#!/bin/bash

# Pack script for packdev
# This script builds the library and creates a tarball for local installation
# Supports both npm and Yarn package managers

set -e  # Exit on any error

# Detect package manager
detect_package_manager() {
    if [ -f "yarn.lock" ]; then
        echo "yarn"
    elif [ -f "package-lock.json" ]; then
        echo "npm"
    elif command -v yarn &> /dev/null; then
        echo "yarn"
    else
        echo "npm"
    fi
}

PACKAGE_MANAGER=$(detect_package_manager)
echo "📋 Detected package manager: $PACKAGE_MANAGER"

echo "🔧 Building the library..."
if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    yarn build
else
    npm run build
fi

echo "📦 Creating package..."
if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    TARBALL=$(yarn pack --filename package.tgz 2>/dev/null && echo "package.tgz")
else
    npm pack
    TARBALL=$(npm pack --dry-run 2>/dev/null | tail -1)
fi

echo "✅ Package created: $TARBALL"
echo ""
echo "📋 Installation Instructions:"
echo "================================"
echo ""
echo "To install this package locally in another project:"
echo "1. Copy the tarball to your target project directory"
echo "2. Run one of the following commands:"
echo ""

if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    echo "   yarn add file:./$TARBALL"
    echo "   # or"
    echo "   yarn add file:$(pwd)/$TARBALL"
    echo ""
    echo "   # npm equivalent:"
    echo "   npm install ./$TARBALL"
else
    echo "   npm install ./$TARBALL"
    echo "   # or"
    echo "   npm install $(pwd)/$TARBALL"
    echo ""
    echo "   # yarn equivalent:"
    echo "   yarn add file:./$TARBALL"
fi

echo ""
echo "To install globally:"
if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    echo "   yarn global add file:./$TARBALL"
    echo "   # or npm: npm install -g ./$TARBALL"
else
    echo "   npm install -g ./$TARBALL"
    echo "   # or yarn: yarn global add file:./$TARBALL"
fi

echo ""
echo "To test the CLI after global installation:"
echo "   packdev --help"
echo ""
echo "To uninstall globally:"
if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    echo "   yarn global remove packdev"
    echo "   # or npm: npm uninstall -g packdev"
else
    echo "   npm uninstall -g packdev"
    echo "   # or yarn: yarn global remove packdev"
fi

echo ""
echo "To install directly from this directory without tarball:"
if [ "$PACKAGE_MANAGER" = "yarn" ]; then
    echo "   yarn add file:$(pwd)"
    echo "   # or npm: npm install $(pwd)"
else
    echo "   npm install $(pwd)"
    echo "   # or yarn: yarn add file:$(pwd)"
fi

echo ""
echo "Note: The tarball contains the built dist/ directory and all necessary files."

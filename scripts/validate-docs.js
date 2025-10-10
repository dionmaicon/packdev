#!/usr/bin/env node

/**
 * Documentation Validation Script
 * Validates all documentation files, links, and structure
 */

const fs = require('fs');
const path = require('path');

function log(message, color = '\x1b[0m') {
  console.log(`${color}${message}\x1b[0m`);
}

function logSuccess(message) {
  log(`✅ ${message}`, '\x1b[32m');
}

function logError(message) {
  log(`❌ ${message}`, '\x1b[31m');
}

function logInfo(message) {
  log(`📋 ${message}`, '\x1b[36m');
}

function logWarning(message) {
  log(`⚠️  ${message}`, '\x1b[33m');
}

function logHeader(message) {
  console.log('\n' + '='.repeat(60));
  log(`🔍 ${message}`, '\x1b[35m');
  console.log('='.repeat(60));
}

class DocumentationValidator {
  constructor() {
    this.projectRoot = process.cwd();
    this.docsDir = path.join(this.projectRoot, 'docs');
    this.errors = [];
    this.warnings = [];
    this.stats = {
      totalFiles: 0,
      totalLines: 0,
      totalLinks: 0,
      brokenLinks: 0,
      validLinks: 0
    };
  }

  async validate() {
    logHeader('Documentation Validation');
    console.log();

    await this.validateStructure();
    await this.validateFiles();
    await this.validateLinks();
    await this.validateConsistency();
    await this.generateReport();
  }

  async validateStructure() {
    logInfo('Validating documentation structure...');

    // Check docs directory exists
    if (!fs.existsSync(this.docsDir)) {
      this.errors.push('docs/ directory not found');
      return;
    }

    // Expected files
    const expectedFiles = [
      'README.md',
      'QUICK-START.md',
      'WORKFLOW.md',
      'PACKAGING.md',
      'YARN-SUPPORT.md',
      'GITHUB-HOOKS.md'
    ];

    const actualFiles = fs.readdirSync(this.docsDir).filter(f => f.endsWith('.md'));

    for (const expected of expectedFiles) {
      if (actualFiles.includes(expected)) {
        logSuccess(`Found ${expected}`);
      } else {
        this.errors.push(`Missing expected file: docs/${expected}`);
      }
    }

    // Check main README
    const mainReadme = path.join(this.projectRoot, 'README.md');
    if (fs.existsSync(mainReadme)) {
      logSuccess('Found main README.md');
    } else {
      this.errors.push('Main README.md not found');
    }

    this.stats.totalFiles = actualFiles.length + (fs.existsSync(mainReadme) ? 1 : 0);
  }

  async validateFiles() {
    logInfo('Validating individual documentation files...');

    const files = [
      { path: 'README.md', name: 'Main README' },
      { path: 'docs/README.md', name: 'Docs Index' },
      { path: 'docs/QUICK-START.md', name: 'Quick Start' },
      { path: 'docs/WORKFLOW.md', name: 'Workflow Guide' },
      { path: 'docs/PACKAGING.md', name: 'Packaging Guide' },
      { path: 'docs/YARN-SUPPORT.md', name: 'Yarn Support' },
      { path: 'docs/GITHUB-HOOKS.md', name: 'GitHub Hooks' }
    ];

    for (const file of files) {
      const filePath = path.join(this.projectRoot, file.path);

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').length;
        this.stats.totalLines += lines;

        // Basic content validation
        if (content.length < 100) {
          this.warnings.push(`${file.name} is very short (${content.length} chars)`);
        }

        // Check for title
        if (!content.startsWith('#')) {
          this.warnings.push(`${file.name} should start with a title (#)`);
        }

        logSuccess(`${file.name}: ${lines} lines`);
      } else {
        this.errors.push(`${file.name} not found at ${file.path}`);
      }
    }
  }

  async validateLinks() {
    logInfo('Validating documentation links...');

    const files = [
      'README.md',
      'docs/README.md',
      'docs/QUICK-START.md',
      'docs/WORKFLOW.md',
      'docs/PACKAGING.md',
      'docs/YARN-SUPPORT.md',
      'docs/GITHUB-HOOKS.md'
    ];

    for (const file of files) {
      const filePath = path.join(this.projectRoot, file);

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        await this.validateLinksInFile(file, content);
      }
    }
  }

  async validateLinksInFile(fileName, content) {
    // Find markdown links [text](path)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      const linkText = match[1];
      const linkPath = match[2];

      this.stats.totalLinks++;

      // Skip external links
      if (linkPath.startsWith('http://') || linkPath.startsWith('https://')) {
        continue;
      }

      // Skip anchors only
      if (linkPath.startsWith('#')) {
        continue;
      }

      // Resolve relative path
      const baseDir = path.dirname(path.join(this.projectRoot, fileName));
      const resolvedPath = path.resolve(baseDir, linkPath);

      if (fs.existsSync(resolvedPath)) {
        this.stats.validLinks++;
        logSuccess(`Valid link in ${fileName}: ${linkText}`);
      } else {
        this.stats.brokenLinks++;
        this.errors.push(`Broken link in ${fileName}: "${linkText}" -> ${linkPath}`);
      }
    }
  }

  async validateConsistency() {
    logInfo('Validating documentation consistency...');

    // Check that main README references docs properly
    const mainReadme = path.join(this.projectRoot, 'README.md');
    if (fs.existsSync(mainReadme)) {
      const content = fs.readFileSync(mainReadme, 'utf8');

      // Should reference docs/
      if (content.includes('./docs/')) {
        logSuccess('Main README references docs/ correctly');
      } else {
        this.warnings.push('Main README should reference ./docs/ directory');
      }

      // Should have documentation section
      if (content.includes('Documentation') || content.includes('Complete Documentation')) {
        logSuccess('Main README has documentation section');
      } else {
        this.warnings.push('Main README should have a documentation section');
      }
    }

    // Check docs index references all guides
    const docsIndex = path.join(this.docsDir, 'README.md');
    if (fs.existsSync(docsIndex)) {
      const content = fs.readFileSync(docsIndex, 'utf8');

      const expectedRefs = [
        'WORKFLOW.md',
        'PACKAGING.md',
        'YARN-SUPPORT.md',
        'GITHUB-HOOKS.md',
        'QUICK-START.md'
      ];

      for (const ref of expectedRefs) {
        if (content.includes(ref)) {
          logSuccess(`Docs index references ${ref}`);
        } else {
          this.warnings.push(`Docs index should reference ${ref}`);
        }
      }
    }
  }

  async generateReport() {
    logHeader('Validation Report');
    console.log();

    // Statistics
    logInfo('📊 Documentation Statistics:');
    console.log(`  📄 Total Files: ${this.stats.totalFiles}`);
    console.log(`  📝 Total Lines: ${this.stats.totalLines.toLocaleString()}`);
    console.log(`  🔗 Total Links: ${this.stats.totalLinks}`);
    console.log(`  ✅ Valid Links: ${this.stats.validLinks}`);
    console.log(`  ❌ Broken Links: ${this.stats.brokenLinks}`);
    console.log();

    // Errors
    if (this.errors.length > 0) {
      logError(`Found ${this.errors.length} error(s):`);
      this.errors.forEach((error, i) => {
        console.log(`  ${i + 1}. ${error}`);
      });
      console.log();
    } else {
      logSuccess('No errors found!');
    }

    // Warnings
    if (this.warnings.length > 0) {
      logWarning(`Found ${this.warnings.length} warning(s):`);
      this.warnings.forEach((warning, i) => {
        console.log(`  ${i + 1}. ${warning}`);
      });
      console.log();
    } else {
      logSuccess('No warnings found!');
    }

    // Overall status
    if (this.errors.length === 0) {
      if (this.warnings.length === 0) {
        logSuccess('🎉 All documentation validation checks passed!');
      } else {
        logWarning(`⚠️ Documentation is valid but has ${this.warnings.length} warning(s)`);
      }
    } else {
      logError(`❌ Documentation validation failed with ${this.errors.length} error(s)`);
    }

    // Quality score
    const totalIssues = this.errors.length + this.warnings.length;
    const quality = Math.max(0, 100 - (this.errors.length * 10) - (this.warnings.length * 2));
    logInfo(`📊 Documentation Quality Score: ${quality}/100`);

    console.log();
    logInfo('💡 Recommendations:');
    console.log('  • Keep all documentation up to date');
    console.log('  • Fix broken links immediately');
    console.log('  • Maintain consistent structure across guides');
    console.log('  • Update the docs index when adding new files');
    console.log('  • Cross-reference related sections');

    return this.errors.length === 0;
  }

  async checkFileStructure() {
    logInfo('Checking file structure standards...');

    const files = [
      'docs/README.md',
      'docs/WORKFLOW.md',
      'docs/PACKAGING.md',
      'docs/YARN-SUPPORT.md',
      'docs/GITHUB-HOOKS.md',
      'docs/QUICK-START.md'
    ];

    for (const file of files) {
      const filePath = path.join(this.projectRoot, file);

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');

        // Check for proper title format
        const lines = content.split('\n');
        const firstLine = lines[0];

        if (!firstLine.startsWith('# ')) {
          this.warnings.push(`${file}: Should start with H1 title (# )`);
        }

        // Check for emoji usage in headers (our standard)
        const headers = lines.filter(line => line.startsWith('#'));
        const hasEmojiHeaders = headers.some(h => /[\u1F300-\u1F9FF]|[\u2600-\u26FF]|[\u2700-\u27BF]/.test(h));

        if (!hasEmojiHeaders && headers.length > 1) {
          this.warnings.push(`${file}: Consider adding emojis to headers for consistency`);
        }

        // Check for code blocks with language specification
        const codeBlocks = content.match(/```(\w+)?\n/g) || [];
        const unspecifiedBlocks = codeBlocks.filter(block => block === '```\n');

        if (unspecifiedBlocks.length > 0) {
          this.warnings.push(`${file}: ${unspecifiedBlocks.length} code block(s) without language specification`);
        }
      }
    }
  }
}

async function main() {
  const validator = new DocumentationValidator();

  try {
    await validator.validate();
    await validator.checkFileStructure();

    const isValid = validator.errors.length === 0;
    process.exit(isValid ? 0 : 1);

  } catch (error) {
    logError(`Validation failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { DocumentationValidator };

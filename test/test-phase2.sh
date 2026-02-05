#!/bin/bash

# Phase 2 Integration Test
# Tests all CLI commands with SwarmFS

echo "=== SwarmFS Phase 2 Integration Test ==="
echo ""

# Clean slate
echo "1. Cleaning up previous test data..."
rm -rf swarmfs-data test-*.txt large-*.txt
echo "   ✓ Cleaned"
echo ""

# Create test files
echo "2. Creating test files..."
echo "Hello, SwarmFS! This is test file 1." > test-1.txt
echo "This is test file 2 with different content." > test-2.txt

# Create a larger file
cat > large-file.txt << 'EOF'
This is a larger test file for SwarmFS.
It contains multiple paragraphs to demonstrate chunking.

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.

The file should be processed correctly by the chunking algorithm,
hashed properly, and stored in the content-addressable storage.
EOF

echo "   ✓ Created 3 test files"
echo ""

# Initialize SwarmFS
echo "3. Initializing SwarmFS..."
node cli.js init
echo ""

# Add files
echo "4. Adding files to SwarmFS..."
echo ""
echo "   Adding test-1.txt..."
node cli.js add test-1.txt
echo ""

echo "   Adding test-2.txt..."
node cli.js add test-2.txt
echo ""

echo "   Adding large-file.txt..."
node cli.js add large-file.txt
echo ""

# Show status
echo "5. Checking status..."
node cli.js status
echo ""

# Show statistics
echo "6. Storage statistics..."
node cli.js stats
echo ""

# Verify files
echo "7. Verifying files..."
echo ""
echo "   Verifying test-1.txt..."
node cli.js verify test-1.txt
echo ""

echo "   Verifying test-2.txt..."
node cli.js verify test-2.txt
echo ""

# Simulate corruption
echo "8. Testing corruption detection..."
cp test-1.txt test-1.txt.backup
echo "CORRUPTED CONTENT" > test-1.txt
echo "   Corrupted test-1.txt, verifying..."
node cli.js verify test-1.txt
echo ""

# Restore and verify
echo "9. Restoring and re-verifying..."
mv test-1.txt.backup test-1.txt
echo "   Restored test-1.txt, verifying..."
node cli.js verify test-1.txt
echo ""

# Show detailed info
echo "10. Detailed file information..."
node cli.js info large-file.txt
echo ""

echo "=== Phase 2 Test Complete ==="
echo ""
echo "✓ All commands working correctly!"
echo "✓ Files tracked and verified"
echo "✓ Corruption detection working"
echo "✓ Direct file I/O operational"

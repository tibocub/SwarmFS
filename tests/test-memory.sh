#!/bin/bash

# Test script for memory leak debugging
# Run with: SWARMFS_MEMORY_DEBUG=1 SWARMFS_VERBOSE=1 ./test-memory.sh

echo "🔍 Starting memory leak test..."
echo "Environment:"
echo "  SWARMFS_MEMORY_DEBUG=${SWARMFS_MEMORY_DEBUG:-0}"
echo "  SWARMFS_VERBOSE=${SWARMFS_VERBOSE:-0}"
echo ""

# Create test files if they don't exist
if [ ! -f "test-large.dat" ]; then
    echo "📁 Creating 2GB test file..."
    dd if=/dev/zero of=test-large.dat bs=1M count=2048 status=progress
fi

if [ ! -f "test-medium.dat" ]; then
    echo "📁 Creating 500MB test file..."
    dd if=/dev/zero of=test-medium.dat bs=1M count=512 status=progress
fi

# Function to monitor memory
monitor_memory() {
    local pid=$1
    local label=$2
    echo "📊 Monitoring memory for $label (PID: $pid)..."
    
    while kill -0 $pid 2>/dev/null; do
        local mem=$(ps -p $pid -o rss= | tr -d ' ')
        local mem_mb=$((mem / 1024))
        local timestamp=$(date '+%H:%M:%S')
        echo "[$timestamp] $label: ${mem_mb}MB RSS"
        sleep 2
    done
}

# Start serving peer
echo ""
echo "🚀 Starting serving peer..."
SWARMFS_MEMORY_DEBUG=1 SWARMFS_VERBOSE=1 node swarmfs.js serve --topic test-memory &
SERVER_PID=$!
sleep 2

# Add file to share
echo "📤 Adding test-large.dat to share..."
SWARMFS_MEMORY_DEBUG=1 node swarmfs.js add test-large.dat
sleep 1

# Share in topic
echo "📡 Sharing in topic..."
SWARMFS_MEMORY_DEBUG=1 node swarmfs.js share test-memory test-large.dat
sleep 1

# Start memory monitor for server
monitor_memory $SERVER_PID "SERVER" &
MONITOR_PID=$!

# Start downloading peer
echo ""
echo "📥 Starting download peer..."
SWARMFS_MEMORY_DEBUG=1 SWARMFS_VERBOSE=1 node swarmfs.js download --topic test-memory --output downloaded-large.dat test-large.dat &
CLIENT_PID=$!

# Monitor client memory too
monitor_memory $CLIENT_PID "CLIENT" &
CLIENT_MONITOR_PID=$!

# Wait for download to complete
echo ""
echo "⏳ Waiting for download to complete..."
wait $CLIENT_PID
CLIENT_EXIT=$?

# Stop monitoring
kill $MONITOR_PID $CLIENT_MONITOR_PID 2>/dev/null
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo ""
echo "✅ Test completed!"
echo "Client exit code: $CLIENT_EXIT"

# Check if file downloaded successfully
if [ -f "downloaded-large.dat" ]; then
    echo "✅ File downloaded successfully"
    
    # Verify file
    echo "🔍 Verifying downloaded file..."
    SWARMFS_MEMORY_DEBUG=1 node swarmfs.js verify downloaded-large.dat
    
    # Check file sizes
    local original_size=$(stat -c%s test-large.dat)
    local downloaded_size=$(stat -c%s downloaded-large.dat)
    
    if [ $original_size -eq $downloaded_size ]; then
        echo "✅ File sizes match: $original_size bytes"
    else
        echo "❌ File size mismatch: $original_size vs $downloaded_size"
    fi
else
    echo "❌ Download failed - file not found"
fi

echo ""
echo "🧹 Cleaning up..."
rm -f test-large.dat test-medium.dat downloaded-large.dat

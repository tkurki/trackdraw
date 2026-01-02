#!/usr/bin/env node

const zlib = require('zlib');

// Read from stdin
let inputData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    inputData += chunk;
});

process.stdin.on('end', () => {
    try {
        const geojson = JSON.parse(inputData);
        const url = createLink(geojson);
        console.log(url);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
});

function createLink(geojson) {
    const baseUrl = 'https://tkurki.github.io/trackdraw/';
    
    // Parse GeoJSON and extract paths
    const paths = parseGeoJSON(geojson);
    
    if (paths.length === 0) {
        throw new Error('No valid LineString or MultiLineString found in GeoJSON');
    }
    
    // Calculate bounds for map center and zoom
    const bounds = calculateBounds(paths);
    
    // Encode paths to binary
    const binary = encodePathsToBinary(paths);
    
    // Compress with deflate
    const compressed = zlib.deflateRawSync(binary);
    
    // Convert to URL-safe base64
    const encoded = toUrlSafeBase64(compressed);
    
    // Build URL
    const params = new URLSearchParams();
    params.set('l', `${bounds.center.lat.toFixed(6)},${bounds.center.lng.toFixed(6)}`);
    params.set('z', bounds.zoom.toString());
    params.set('d', encoded);
    
    return `${baseUrl}#${params.toString()}`;
}

function parseGeoJSON(geojson) {
    let features = [];
    
    // Handle different GeoJSON structures
    if (geojson.type === 'FeatureCollection') {
        features = geojson.features;
    } else if (geojson.type === 'Feature') {
        features = [geojson];
    } else if (geojson.type === 'LineString' || geojson.type === 'MultiLineString') {
        features = [{ type: 'Feature', geometry: geojson }];
    } else {
        throw new Error('Unsupported GeoJSON type. Use LineString or MultiLineString.');
    }
    
    const paths = [];
    
    features.forEach(feature => {
        const geometry = feature.geometry || feature;
        if (!geometry || !geometry.coordinates) return;
        
        if (geometry.type === 'LineString') {
            const points = geometry.coordinates.map(coord => ({
                lat: coord[1],
                lng: coord[0]
            }));
            
            if (points.length >= 2) {
                paths.push({
                    points,
                    strokeWidth: 4, // Standard width
                    type: 'line',
                    colorIndex: 0 // Red
                });
            }
        } else if (geometry.type === 'MultiLineString') {
            geometry.coordinates.forEach(lineCoords => {
                const points = lineCoords.map(coord => ({
                    lat: coord[1],
                    lng: coord[0]
                }));
                
                if (points.length >= 2) {
                    paths.push({
                        points,
                        strokeWidth: 4,
                        type: 'line',
                        colorIndex: 0
                    });
                }
            });
        }
    });
    
    return paths;
}

function calculateBounds(paths) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    
    paths.forEach(path => {
        path.points.forEach(p => {
            minLat = Math.min(minLat, p.lat);
            maxLat = Math.max(maxLat, p.lat);
            minLng = Math.min(minLng, p.lng);
            maxLng = Math.max(maxLng, p.lng);
        });
    });
    
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    const latDiff = maxLat - minLat;
    const lngDiff = maxLng - minLng;
    
    // Calculate appropriate zoom level
    const maxDiff = Math.max(latDiff, lngDiff);
    let zoom = 13;
    if (maxDiff < 0.001) zoom = 18;
    else if (maxDiff < 0.01) zoom = 15;
    else if (maxDiff < 0.1) zoom = 12;
    else if (maxDiff < 1) zoom = 9;
    else zoom = 7;
    
    return {
        center: { lat: centerLat, lng: centerLng },
        zoom
    };
}

function normalizePathPoints(rawPoints) {
    const normalized = [];
    let lastLat = null;
    let lastLng = null;
    
    rawPoints.forEach(point => {
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
        const latInt = Math.round(point.lat * 1e6);
        const lngInt = Math.round(point.lng * 1e6);
        if (normalized.length === 0 || latInt !== lastLat || lngInt !== lastLng) {
            normalized.push({ lat: latInt, lng: lngInt });
            lastLat = latInt;
            lastLng = lngInt;
        }
    });
    
    return normalized;
}

function writeVarUint(target, value) {
    let v = value >>> 0;
    while (v >= 0x80) {
        target.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    target.push(v & 0x7f);
}

function writeVarInt(target, value) {
    let zigzag = ((value << 1) ^ (value >> 31)) >>> 0;
    while (zigzag >= 0x80) {
        target.push((zigzag & 0x7f) | 0x80);
        zigzag >>>= 7;
    }
    target.push(zigzag & 0x7f);
}

function encodePathsToBinary(paths) {
    const typeToCode = { freehand: 0, line: 1, circle: 2, arrow: 3 };
    const widthOptions = [2, 4, 6, 10];
    const prepared = [];
    
    paths.forEach(path => {
        const normalized = normalizePathPoints(path.points);
        if (normalized.length === 0) return;
        
        const colorIndex = Math.max(0, Math.min(15, path.colorIndex || 0));
        
        // Find closest width index
        let widthIndex = 1; // Default to index 1 (width 4)
        let bestDiff = Number.POSITIVE_INFINITY;
        widthOptions.forEach((width, index) => {
            const diff = Math.abs(width - (path.strokeWidth || 4));
            if (diff < bestDiff) {
                bestDiff = diff;
                widthIndex = index;
            }
        });
        
        const typeCode = typeToCode[path.type] || typeToCode.line;
        
        prepared.push({
            typeCode,
            widthIndex,
            colorIndex,
            points: normalized
        });
    });
    
    const bytes = [];
    bytes.push(2); // version
    writeVarUint(bytes, prepared.length);
    
    prepared.forEach(path => {
        const meta = ((path.typeCode & 0x03) << 6) | ((path.widthIndex & 0x03) << 4) | (path.colorIndex & 0x0f);
        bytes.push(meta & 0xff);
        writeVarUint(bytes, path.points.length);
        
        let prevLat = 0;
        let prevLng = 0;
        path.points.forEach((point, index) => {
            const lat = point.lat | 0;
            const lng = point.lng | 0;
            if (index === 0) {
                writeVarInt(bytes, lat);
                writeVarInt(bytes, lng);
            } else {
                writeVarInt(bytes, lat - prevLat);
                writeVarInt(bytes, lng - prevLng);
            }
            prevLat = lat;
            prevLng = lng;
        });
    });
    
    return Buffer.from(bytes);
}

function toUrlSafeBase64(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

const axios = require('axios');

/**
 * Provider-Agnostic Map, Geocoding & Routing Service (Section 19)
 * Supports Google Maps Platform (when GOOGLE_MAPS_API_KEY is configured)
 * + OpenStreetMap (Nominatim / OSRM) + Built-in Indian Locality Gazetteer fallback
 */

const BUILTIN_LOCALITIES = [
    { name: 'Vaishali Nagar, Jaipur', lat: 26.9115, lng: 75.7412 },
    { name: 'Mansarovar Sector 5, Jaipur', lat: 26.8549, lng: 75.7681 },
    { name: 'Malviya Nagar, Jaipur', lat: 26.8536, lng: 75.8185 },
    { name: 'C-Scheme, अशोक नगर, Jaipur', lat: 26.9065, lng: 75.8001 },
    { name: 'Raja Park, Jaipur', lat: 26.8974, lng: 75.8266 },
    { name: 'Jhotwara, Jaipur', lat: 26.9438, lng: 75.7436 },
    { name: 'Vidyadhar Nagar, Jaipur', lat: 26.9628, lng: 75.7815 },
    { name: 'Bani Park, Jaipur', lat: 26.9293, lng: 75.7885 },
    { name: 'Tonk Road, Gopalanura, Jaipur', lat: 26.8663, lng: 75.7955 },
    { name: 'Jagatpura, Jaipur', lat: 26.8351, lng: 75.8588 },
    { name: 'Nirman Nagar, Ajmer Road, Jaipur', lat: 26.8868, lng: 75.7521 },
    { name: 'Sodala, Shyam Nagar, Jaipur', lat: 26.8975, lng: 75.7706 },
    { name: 'Pratap Nagar, Sanganer, Jaipur', lat: 26.8035, lng: 75.8168 },
    { name: 'Civil Lines, Jaipur', lat: 26.9048, lng: 75.7824 },
    { name: 'Chitrakoot Stadium, Vaishali Nagar, Jaipur', lat: 26.9012, lng: 75.7364 }
];

const geocodeCache = new Map();

/**
 * Haversine distance in kilometres between two coordinates
 */
const haversineKm = (lat1, lng1, lat2, lng2) => {
    if (
        lat1 === null || lat1 === undefined ||
        lng1 === null || lng1 === undefined ||
        lat2 === null || lat2 === undefined ||
        lng2 === null || lng2 === undefined
    ) {
        return Infinity;
    }
    const R = 6371;
    const dLat = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
    const dLng = ((Number(lng2) - Number(lng1)) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((Number(lat1) * Math.PI) / 180) *
            Math.cos((Number(lat2) * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

/**
 * Minimum distance (km) from point P(lat,lng) to line segment A(lat1,lng1) -> B(lat2,lng2)
 */
const pointToSegmentDistanceKm = (pLat, pLng, aLat, aLng, bLat, bLng) => {
    const x = Number(pLng);
    const y = Number(pLat);
    const x1 = Number(aLng);
    const y1 = Number(aLat);
    const x2 = Number(bLng);
    const y2 = Number(bLat);

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;
    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    return haversineKm(y, x, yy, xx);
};

/**
 * Geocode a human-readable address into { originalAddress, normalizedAddress, lat, lng, provider }
 */
const geocodeAddress = async (address, defaultCenter = { lat: 26.9124, lng: 75.7873 }) => {
    const clean = String(address || '').trim();
    if (!clean) {
        throw new Error('Address is required for geocoding');
    }

    const cacheKey = clean.toLowerCase();
    if (geocodeCache.has(cacheKey)) {
        return geocodeCache.get(cacheKey);
    }

    // 1. Check built-in gazetteer match first for instant zero-latency accuracy
    const localMatch = BUILTIN_LOCALITIES.find(loc =>
        clean.toLowerCase().includes(loc.name.split(',')[0].toLowerCase()) ||
        loc.name.toLowerCase().includes(clean.toLowerCase())
    );
    if (localMatch) {
        const res = {
            originalAddress: clean,
            normalizedAddress: localMatch.name,
            lat: localMatch.lat,
            lng: localMatch.lng,
            provider: 'LocalGazetteer',
            geocodeStatus: 'Verified'
        };
        geocodeCache.set(cacheKey, res);
        return res;
    }

    // 2. Try Google Maps Geocoding API if configured
    if (process.env.GOOGLE_MAPS_API_KEY) {
        try {
            const gRes = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: { address: clean, key: process.env.GOOGLE_MAPS_API_KEY },
                timeout: 4000
            });
            if (gRes.data?.results?.length > 0) {
                const top = gRes.data.results[0];
                const res = {
                    originalAddress: clean,
                    normalizedAddress: top.formatted_address,
                    lat: top.geometry.location.lat,
                    lng: top.geometry.location.lng,
                    placeId: top.place_id,
                    provider: 'GoogleMaps',
                    geocodeStatus: 'Verified'
                };
                geocodeCache.set(cacheKey, res);
                return res;
            }
        } catch (err) {
            // Fall through to Nominatim
        }
    }

    // 3. Try OpenStreetMap Nominatim
    try {
        const nomRes = await axios.get('https://nominatim.openstreetmap.org/search', {
            params: { q: clean, format: 'json', limit: 1 },
            headers: { 'User-Agent': 'SchoolTransportCRM/2.0' },
            timeout: 3500
        });
        if (Array.isArray(nomRes.data) && nomRes.data.length > 0) {
            const top = nomRes.data[0];
            const res = {
                originalAddress: clean,
                normalizedAddress: top.display_name,
                lat: Number(top.lat),
                lng: Number(top.lon),
                provider: 'OpenStreetMap',
                geocodeStatus: 'Verified'
            };
            geocodeCache.set(cacheKey, res);
            return res;
        }
    } catch (err) {
        // Fall through to deterministic locality offset around school center
    }

    // 4. Deterministic fallback so offline/restricted environments never fail
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
        hash = (hash << 5) - hash + clean.charCodeAt(i);
        hash |= 0;
    }
    const latOffset = ((hash % 600) / 10000); // within ~6km
    const lngOffset = (((hash >> 4) % 600) / 10000);

    const fallbackRes = {
        originalAddress: clean,
        normalizedAddress: `${clean} (School Transport Zone)`,
        lat: Number((defaultCenter.lat + latOffset).toFixed(6)),
        lng: Number((defaultCenter.lng + lngOffset).toFixed(6)),
        provider: 'FallbackEstimator',
        geocodeStatus: 'Approximate'
    };
    geocodeCache.set(cacheKey, fallbackRes);
    return fallbackRes;
};

/**
 * Autocomplete address suggestions
 */
const autocompleteAddress = async (query) => {
    const q = String(query || '').trim().toLowerCase();
    const localHits = BUILTIN_LOCALITIES.filter(l => !q || l.name.toLowerCase().includes(q)).slice(0, 8);
    return localHits.map(l => ({
        description: l.name,
        lat: l.lat,
        lng: l.lng,
        provider: 'LocalGazetteer'
    }));
};

/**
 * Calculate route distance, duration, and polyline geometry for an ordered array of stops + school endpoint
 */
const calculateRouteGeometry = (stops = [], schoolPoint = null) => {
    const validStops = (stops || []).filter(s => s && s.lat !== undefined && s.lng !== undefined);
    const waypoints = [...validStops.map(s => ({ lat: Number(s.lat), lng: Number(s.lng), name: s.stopName || s.name }))];
    if (schoolPoint && schoolPoint.lat && schoolPoint.lng) {
        waypoints.push({ lat: Number(schoolPoint.lat), lng: Number(schoolPoint.lng), name: 'School Campus' });
    }

    if (waypoints.length < 2) {
        return {
            plannedKm: waypoints.length === 1 ? 5 : 0,
            plannedMinutes: waypoints.length === 1 ? 15 : 0,
            geometry: waypoints.map(w => [w.lat, w.lng]),
            stopsWithCumulativeKm: stops
        };
    }

    const ROAD_CIRCUITY_FACTOR = 1.28; // Urban road distance vs straight line
    const AVG_SPEED_KMH = 24;          // School bus average urban speed including stops
    const DWELL_MINUTES_PER_STOP = 1.5;

    let cumulativeKm = 0;
    const geometry = [[waypoints[0].lat, waypoints[0].lng]];
    const stopsWithCumulativeKm = validStops.map((s, idx) => {
        if (idx > 0) {
            const legStraight = haversineKm(waypoints[idx - 1].lat, waypoints[idx - 1].lng, waypoints[idx].lat, waypoints[idx].lng);
            cumulativeKm += legStraight * ROAD_CIRCUITY_FACTOR;
        }
        geometry.push([Number(s.lat), Number(s.lng)]);
        return {
            ...s,
            sequence: idx + 1,
            distanceFromStartKm: Number(cumulativeKm.toFixed(2))
        };
    });

    // Final leg from last stop to school
    if (schoolPoint && schoolPoint.lat && schoolPoint.lng) {
        const lastStop = waypoints[waypoints.length - 2];
        const finalLeg = haversineKm(lastStop.lat, lastStop.lng, schoolPoint.lat, schoolPoint.lng) * ROAD_CIRCUITY_FACTOR;
        cumulativeKm += finalLeg;
        geometry.push([Number(schoolPoint.lat), Number(schoolPoint.lng)]);
    }

    const plannedOneWayKm = Number(cumulativeKm.toFixed(2));
    const plannedRoundTripKm = Number((plannedOneWayKm * 2).toFixed(2));
    const plannedMinutes = Math.round((plannedOneWayKm / AVG_SPEED_KMH) * 60 + validStops.length * DWELL_MINUTES_PER_STOP);

    return {
        plannedOneWayKm,
        plannedKm: plannedRoundTripKm,
        plannedMinutes,
        geometry,
        stopsWithCumulativeKm
    };
};

/**
 * Given an existing route's ordered stops and a candidate student point (lat, lng),
 * find the nearest stop, minimum distance to route polyline, optimal insertion position,
 * and added detour distance (km) + added time (minutes).
 */
const calculateInsertionDetour = (route, studentLat, studentLng, schoolPoint = { lat: 26.9124, lng: 75.7873 }) => {
    const pLat = Number(studentLat);
    const pLng = Number(studentLng);
    const stops = (route?.stops || []).filter(s => s && s.lat !== undefined && s.lng !== undefined);

    const ROAD_CIRCUITY_FACTOR = 1.28;
    const AVG_SPEED_KMH = 24;

    if (stops.length === 0) {
        const distToSchool = haversineKm(pLat, pLng, schoolPoint.lat, schoolPoint.lng) * ROAD_CIRCUITY_FACTOR;
        return {
            nearestStop: { stopName: 'Direct Pickup Point', sequence: 1, lat: pLat, lng: pLng },
            distanceFromRouteKm: Number(distToSchool.toFixed(2)),
            insertAfterSequence: 0,
            detourOneWayKm: Number(distToSchool.toFixed(2)),
            detourRoundTripKm: Number((distToSchool * 2).toFixed(2)),
            detourMinutes: Math.round((distToSchool / AVG_SPEED_KMH) * 60 + 2),
            beforeGeometry: [[schoolPoint.lat, schoolPoint.lng]],
            afterGeometry: [[pLat, pLng], [schoolPoint.lat, schoolPoint.lng]]
        };
    }

    // 1. Find nearest existing stop
    let nearestStop = stops[0];
    let minStopDist = Infinity;
    stops.forEach((s, idx) => {
        const d = haversineKm(pLat, pLng, s.lat, s.lng);
        if (d < minStopDist) {
            minStopDist = d;
            nearestStop = { ...s, sequence: s.sequence || idx + 1 };
        }
    });

    // 2. Find minimum perpendicular distance to any route segment
    const chain = [
        ...stops.map((s, idx) => ({ lat: Number(s.lat), lng: Number(s.lng), stopName: s.stopName, sequence: idx + 1 })),
        { lat: Number(schoolPoint.lat), lng: Number(schoolPoint.lng), stopName: 'School Campus', sequence: stops.length + 1 }
    ];

    let minSegmentDist = minStopDist;
    for (let i = 0; i < chain.length - 1; i++) {
        const segDist = pointToSegmentDistanceKm(pLat, pLng, chain[i].lat, chain[i].lng, chain[i + 1].lat, chain[i + 1].lng);
        if (segDist < minSegmentDist) minSegmentDist = segDist;
    }

    // 3. If student is within 250m of an existing stop, they can board at that existing stop with ~0 detour!
    if (minStopDist <= 0.25) {
        const beforeGeom = chain.map(c => [c.lat, c.lng]);
        return {
            nearestStop,
            boardsAtExistingStop: true,
            distanceFromRouteKm: Number(minStopDist.toFixed(2)),
            insertAfterSequence: nearestStop.sequence,
            detourOneWayKm: 0,
            detourRoundTripKm: 0,
            detourMinutes: 1, // 1 min boarding dwell time
            beforeGeometry: beforeGeom,
            afterGeometry: beforeGeom
        };
    }

    // 4. Find optimal insertion slot among consecutive points in chain that minimizes added distance
    let bestInsertAfterIdx = 0;
    let minAddedStraightKm = Infinity;

    // Option A: Insert before first stop
    const beforeFirstKm = haversineKm(pLat, pLng, chain[0].lat, chain[0].lng);
    minAddedStraightKm = beforeFirstKm;
    bestInsertAfterIdx = 0;

    // Option B: Insert between chain[i] and chain[i+1]
    for (let i = 0; i < chain.length - 1; i++) {
        const origLeg = haversineKm(chain[i].lat, chain[i].lng, chain[i + 1].lat, chain[i + 1].lng);
        const newLeg =
            haversineKm(chain[i].lat, chain[i].lng, pLat, pLng) +
            haversineKm(pLat, pLng, chain[i + 1].lat, chain[i + 1].lng);
        const added = Math.max(0, newLeg - origLeg);
        if (added < minAddedStraightKm) {
            minAddedStraightKm = added;
            bestInsertAfterIdx = i + 1;
        }
    }

    const detourOneWayKm = Number((minAddedStraightKm * ROAD_CIRCUITY_FACTOR).toFixed(2));
    const detourRoundTripKm = Number((detourOneWayKm * 2).toFixed(2));
    const detourMinutes = Math.max(1, Math.round((detourOneWayKm / AVG_SPEED_KMH) * 60 + 1.5));

    const beforeGeometry = chain.map(c => [c.lat, c.lng]);
    const afterGeometry = [...beforeGeometry];
    afterGeometry.splice(bestInsertAfterIdx, 0, [pLat, pLng]);

    return {
        nearestStop,
        boardsAtExistingStop: false,
        distanceFromRouteKm: Number(minSegmentDist.toFixed(2)),
        insertAfterSequence: bestInsertAfterIdx,
        detourOneWayKm,
        detourRoundTripKm,
        detourMinutes,
        beforeGeometry,
        afterGeometry
    };
};

module.exports = {
    BUILTIN_LOCALITIES,
    haversineKm,
    pointToSegmentDistanceKm,
    geocodeAddress,
    autocompleteAddress,
    calculateRouteGeometry,
    calculateInsertionDetour
};

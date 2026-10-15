const asyncHandler = require('express-async-handler');
const Route = require('../models/Route');
const Stop = require('../models/Stop');
const Company = require('../models/Company');
const Vehicle = require('../models/Vehicle');
const { calculateRouteGeometry, haversineKm } = require('../services/mapProviderService');

const syncStopsCollection = async (routeDoc) => {
    if (!routeDoc || !Array.isArray(routeDoc.stops)) return;
    await Stop.deleteMany({ route: routeDoc._id });
    const docs = routeDoc.stops.map((s, idx) => ({
        company: routeDoc.company,
        route: routeDoc._id,
        sequence: s.sequence || idx + 1,
        name: s.stopName,
        address: s.address || s.stopName,
        lat: Number(s.lat),
        lng: Number(s.lng),
        plannedTime: s.expectedTime || '07:30 AM',
        distanceFromStartKm: Number(s.distanceFromStartKm) || 0,
        zoneFeeDefault: Number(s.zoneFeeDefault) || 0
    }));
    if (docs.length > 0) {
        await Stop.insertMany(docs);
    }
};

// @desc    Get all routes
// @route   GET /api/routes/:companyId
// @access  Private/Admin
const getRoutes = asyncHandler(async (req, res) => {
    const routes = await Route.find({ company: req.params.companyId })
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats status')
        .sort({ createdAt: -1 })
        .lean();
    res.json(routes);
});

// @desc    Create route
// @route   POST /api/routes
// @access  Private/Admin
const createRoute = asyncHandler(async (req, res) => {
    const { name, code, company, assignedBus, stops = [], shift, direction, defaultFeeAmount, operatingDaysPerMonth } = req.body;
    const companyDoc = await Company.findById(company).lean();
    const geomInfo = calculateRouteGeometry(stops, {
        lat: companyDoc?.schoolLat || 26.9124,
        lng: companyDoc?.schoolLng || 75.7873
    });

    const route = await Route.create({
        name,
        code: code || `RT-${String(name).slice(0, 3).toUpperCase()}-${Math.floor(10 + Math.random() * 89)}`,
        company,
        assignedBus: assignedBus || null,
        stops: geomInfo.stopsWithCumulativeKm || stops,
        shift: shift || 'Both',
        direction: direction || 'RoundTrip',
        plannedKm: Number(req.body.plannedKm) || geomInfo.plannedKm,
        plannedMinutes: Number(req.body.plannedMinutes) || geomInfo.plannedMinutes,
        geometry: geomInfo.geometry,
        defaultFeeAmount: Number(defaultFeeAmount) || 0,
        operatingDaysPerMonth: Number(operatingDaysPerMonth) || 22
    });

    if (assignedBus) {
        await Vehicle.findByIdAndUpdate(assignedBus, { routeAssigned: route._id });
    }
    await syncStopsCollection(route);

    const populated = await Route.findById(route._id)
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats status');
    res.status(201).json(populated);
});

// @desc    Update route
// @route   PUT /api/routes/:id
// @access  Private/Admin
const updateRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }

    const companyDoc = await Company.findById(route.company).lean();
    const stops = req.body.stops !== undefined ? req.body.stops : route.stops;
    const geomInfo = calculateRouteGeometry(stops, {
        lat: companyDoc?.schoolLat || 26.9124,
        lng: companyDoc?.schoolLng || 75.7873
    });

    const updatePayload = {
        ...req.body,
        stops: geomInfo.stopsWithCumulativeKm || stops,
        plannedKm: req.body.plannedKm !== undefined ? Number(req.body.plannedKm) : geomInfo.plannedKm,
        plannedMinutes: req.body.plannedMinutes !== undefined ? Number(req.body.plannedMinutes) : geomInfo.plannedMinutes,
        geometry: geomInfo.geometry
    };

    const updated = await Route.findByIdAndUpdate(req.params.id, updatePayload, { new: true })
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats status');

    if (updated.assignedBus) {
        await Vehicle.findByIdAndUpdate(updated.assignedBus._id || updated.assignedBus, { routeAssigned: updated._id });
    }
    await syncStopsCollection(updated);

    res.json(updated);
});

// @desc    Delete route
// @route   DELETE /api/routes/:id
// @access  Private/Admin
const deleteRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }
    await Stop.deleteMany({ route: route._id });
    await route.deleteOne();
    res.json({ message: 'Route removed' });
});

// @desc    Find nearest route for a location
// @route   POST /api/routes/nearest/:companyId
// @access  Private/Admin
const findNearestRoute = asyncHandler(async (req, res) => {
    const { lat, lng } = req.body;
    if (!lat || !lng) {
        res.status(400);
        throw new Error('Latitude and Longitude are required');
    }

    const routes = await Route.find({ company: req.params.companyId, isActive: true })
        .populate('assignedBus', 'carNumber displayCode busType seatingCapacity reservedSeats');

    let nearestRoute = null;
    let nearestStop = null;
    let minDistance = Infinity;

    routes.forEach(route => {
        if (!route.stops) return;
        route.stops.forEach(stop => {
            const dist = haversineKm(lat, lng, stop.lat, stop.lng);
            if (dist < minDistance) {
                minDistance = dist;
                nearestStop = stop;
                nearestRoute = route;
            }
        });
    });

    if (nearestRoute) {
        res.json({
            nearestRoute: {
                _id: nearestRoute._id,
                name: nearestRoute.name,
                assignedBus: nearestRoute.assignedBus,
                stops: nearestRoute.stops
            },
            nearestStop,
            distanceKm: minDistance.toFixed(2)
        });
    } else {
        res.status(404).json({ message: 'No active routes with stops found' });
    }
});

// @desc    Optimize route stop sequence using greedy TSP
// @route   POST /api/routes/optimize/:id
// @access  Private/Admin
const optimizeRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route || !route.stops || route.stops.length < 3) {
        res.status(400);
        throw new Error('Route needs at least 3 stops to be optimized');
    }

    let unvisited = [...route.stops.map((stop, index) => ({ ...stop.toObject(), originalIndex: index }))];
    let currentStop = unvisited.shift();
    const optimizedStops = [currentStop];

    while (unvisited.length > 0) {
        let nearestIdx = 0;
        let minDistance = Infinity;
        for (let i = 0; i < unvisited.length; i++) {
            const dist = haversineKm(currentStop.lat, currentStop.lng, unvisited[i].lat, unvisited[i].lng);
            if (dist < minDistance) {
                minDistance = dist;
                nearestIdx = i;
            }
        }
        currentStop = unvisited[nearestIdx];
        optimizedStops.push(currentStop);
        unvisited.splice(nearestIdx, 1);
    }

    const companyDoc = await Company.findById(route.company).lean();
    const geomInfo = calculateRouteGeometry(optimizedStops, {
        lat: companyDoc?.schoolLat || 26.9124,
        lng: companyDoc?.schoolLng || 75.7873
    });

    route.stops = geomInfo.stopsWithCumulativeKm;
    route.plannedKm = geomInfo.plannedKm;
    route.plannedMinutes = geomInfo.plannedMinutes;
    route.geometry = geomInfo.geometry;
    await route.save();
    await syncStopsCollection(route);

    res.json({ message: 'Route optimized successfully', route });
});

module.exports = {
    getRoutes,
    createRoute,
    updateRoute,
    deleteRoute,
    findNearestRoute,
    optimizeRoute
};

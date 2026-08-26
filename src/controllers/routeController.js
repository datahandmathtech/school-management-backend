const asyncHandler = require('express-async-handler');
const Route = require('../models/Route');

// @desc    Get all routes
// @route   GET /api/routes/:companyId
// @access  Private/Admin
const getRoutes = asyncHandler(async (req, res) => {
    const routes = await Route.find({ company: req.params.companyId })
                              .populate('assignedBus', 'carNumber busType')
                              .sort({ createdAt: -1 })
                              .lean();
    res.json(routes);
});

// @desc    Create route
// @route   POST /api/routes
// @access  Private/Admin
const createRoute = asyncHandler(async (req, res) => {
    const { name, company, assignedBus, stops, shift } = req.body;
    
    const route = await Route.create({
        name, company, assignedBus, stops, shift
    });

    res.status(201).json(route);
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

    const updated = await Route.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate('assignedBus', 'carNumber busType');
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
                              .populate('assignedBus', 'carNumber busType seatingCapacity');

    let nearestRoute = null;
    let nearestStop = null;
    let minDistance = Infinity;

    // Haversine formula
    const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
        const R = 6371; // Radius of the earth in km
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a = 
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
            Math.sin(dLon / 2) * Math.sin(dLon / 2); 
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
        return R * c; // Distance in km
    };

    routes.forEach(route => {
        if (!route.stops) return;
        route.stops.forEach(stop => {
            const dist = getDistanceFromLatLonInKm(lat, lng, stop.lat, stop.lng);
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

// @desc    Optimize route using AI/TSP logic
// @route   POST /api/routes/optimize/:id
// @access  Private/Admin
const optimizeRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route || !route.stops || route.stops.length < 3) {
        res.status(400);
        throw new Error('Route needs at least 3 stops to be optimized');
    }

    const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
        const R = 6371; 
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a = 
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
            Math.sin(dLon / 2) * Math.sin(dLon / 2); 
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
        return R * c; 
    };

    // Simple Greedy TSP: Start from the first stop, find the nearest next stop, and so on.
    // In a real AI context, we might call a Mapbox/Google Maps Matrix API or a Python ML endpoint.
    let unvisited = [...route.stops.map((stop, index) => ({ ...stop.toObject(), originalIndex: index }))];
    let currentStop = unvisited.shift(); // Assume first stop is the school/depot
    let optimizedStops = [currentStop];

    while (unvisited.length > 0) {
        let nearestIdx = 0;
        let minDistance = Infinity;

        for (let i = 0; i < unvisited.length; i++) {
            const dist = getDistanceFromLatLonInKm(currentStop.lat, currentStop.lng, unvisited[i].lat, unvisited[i].lng);
            if (dist < minDistance) {
                minDistance = dist;
                nearestIdx = i;
            }
        }
        
        currentStop = unvisited[nearestIdx];
        optimizedStops.push(currentStop);
        unvisited.splice(nearestIdx, 1);
    }

    route.stops = optimizedStops.map(s => ({ stopName: s.stopName, lat: s.lat, lng: s.lng, expectedTime: s.expectedTime }));
    await route.save();

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

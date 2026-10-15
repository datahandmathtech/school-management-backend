const Company = require('../models/Company');
const Route = require('../models/Route');
const FeePlan = require('../models/FeePlan');
const Student = require('../models/Student');
const OptimizationRun = require('../models/OptimizationRun');
const { roundMoney, addMoney, subMoney, mulMoney, divMoney } = require('../utils/moneyUtils');
const { calculateTransportProfitability } = require('./profitabilityService');
const { geocodeAddress, calculateInsertionDetour } = require('./mapProviderService');

/**
 * Financially Aware Route Recommendation & Simulation Service (Sections 12, 13, 16.5)
 * Combines:
 * 1. Hard operational constraints (active status, shift compatibility, available seats > 0, max detour time)
 * 2. Proximity & detour calculation (Added KM & Added Minutes)
 * 3. Incremental monthly economics (Incremental Fee Revenue - Incremental Variable Cost = Incremental Contribution)
 * 4. Configurable 5-component weighted scoring + human-readable explanation reasons
 */
const evaluateRouteRecommendations = async ({
    companyId,
    studentId = null,
    studentName = '',
    address = '',
    lat = null,
    lng = null,
    shift = 'Both',
    direction = 'Two-Way',
    searchRadiusKm = 8,
    feePlanId = null,
    customMonthlyFee = null,
    saveRun = true,
    user = null
}) => {
    const company = await Company.findById(companyId).lean();
    const schoolPoint = {
        lat: Number(company?.schoolLat) || 26.9124,
        lng: Number(company?.schoolLng) || 75.7873
    };

    // 1. Resolve coordinates (via explicit lat/lng, student record, or geocoding address)
    let resolvedLat = lat !== null && lat !== undefined && lat !== '' ? Number(lat) : null;
    let resolvedLng = lng !== null && lng !== undefined && lng !== '' ? Number(lng) : null;
    let inputAddress = address || '';
    let normalizedAddress = address || '';
    let studentDoc = null;

    if (studentId) {
        studentDoc = await Student.findOne({ _id: studentId, company: companyId }).lean();
        if (studentDoc) {
            studentName = studentName || studentDoc.name;
            if (!inputAddress) inputAddress = studentDoc.originalAddress || studentDoc.pickupLocationName || '';
            if (resolvedLat === null && studentDoc.pickupLat) resolvedLat = Number(studentDoc.pickupLat);
            if (resolvedLng === null && studentDoc.pickupLng) resolvedLng = Number(studentDoc.pickupLng);
        }
    }

    if ((resolvedLat === null || resolvedLng === null) && inputAddress) {
        const geo = await geocodeAddress(inputAddress, schoolPoint);
        resolvedLat = geo.lat;
        resolvedLng = geo.lng;
        normalizedAddress = geo.normalizedAddress;
    }

    if (resolvedLat === null || resolvedLng === null) {
        const err = new Error('Student address or map coordinates (lat/lng) are required for route optimization');
        err.statusCode = 400;
        throw err;
    }

    // 2. Get current period profitability & capacity snapshot for all buses and routes
    const profitability = await calculateTransportProfitability(companyId, {});
    const routes = await Route.find({ company: companyId })
        .populate('assignedBus')
        .lean();

    let feePlanDoc = null;
    if (feePlanId) {
        feePlanDoc = await FeePlan.findOne({ _id: feePlanId, company: companyId }).lean();
    }

    const weights = company?.optimizerWeights || {
        routeProximity: 25,
        detourDistanceEfficiency: 20,
        addedTimeEfficiency: 20,
        capacityHealth: 10,
        incrementalFinancialContribution: 25
    };

    const maxDetourMinutesPolicy = Number(company?.alertThresholds?.maxDetourMinutes) || 20;
    const operatingDays = Number(company?.operatingDaysPerMonth) || 22;
    const defaultVarCostPerKm = Number(company?.defaultVariableCostPerKm) || 18;
    const radiusLimit = Number(searchRadiusKm) || 8;

    const busFinancialMap = {};
    profitability.busSummary.forEach(bm => {
        busFinancialMap[String(bm.busId)] = bm;
    });

    // Build candidate pool from routes and buses
    const rawCandidates = [];

    for (const route of routes) {
        const busObj = route.assignedBus;
        const bId = busObj ? String(busObj._id || busObj) : null;
        const busMetrics = bId ? busFinancialMap[bId] : null;

        const detour = calculateInsertionDetour(route, resolvedLat, resolvedLng, schoolPoint);

        const usableCapacity = busMetrics ? busMetrics.capacity.usableCapacity : (Number(busObj?.seatingCapacity) || 35);
        const occupiedBefore = busMetrics ? busMetrics.capacity.occupiedSeats : 0;
        const availableBefore = busMetrics ? busMetrics.capacity.availableSeats : usableCapacity;

        // Check hard constraints (Section 12 & 13)
        const rejectionReasons = [];
        if (!route.isActive || route.status === 'inactive') {
            rejectionReasons.push('Route is inactive');
        }
        if (!busObj) {
            rejectionReasons.push('No bus assigned to route');
        } else if (busObj.status === 'inactive') {
            rejectionReasons.push(`Bus ${busObj.carNumber} is inactive`);
        }
        if (availableBefore <= 0) {
            rejectionReasons.push(`Bus Full (${occupiedBefore}/${usableCapacity} seats occupied)`);
        }
        if (shift && shift !== 'Both' && route.shift !== 'Both' && route.shift !== shift) {
            rejectionReasons.push(`Shift mismatch (Route is ${route.shift}, requested ${shift})`);
        }
        if (detour.distanceFromRouteKm > radiusLimit) {
            rejectionReasons.push(`Outside search radius (${detour.distanceFromRouteKm} km > ${radiusLimit} km)`);
        }
        if (detour.detourMinutes > maxDetourMinutesPolicy) {
            rejectionReasons.push(`Exceeds max detour time policy (+${detour.detourMinutes} min > ${maxDetourMinutesPolicy} min)`);
        }

        const feasible = rejectionReasons.length === 0;

        // Incremental Economics (Section 13.1)
        let expectedMonthlyRevenue = roundMoney(
            customMonthlyFee !== null && customMonthlyFee !== undefined && customMonthlyFee !== ''
                ? customMonthlyFee
                : feePlanDoc
                    ? (feePlanDoc.frequency === 'Annual'
                        ? divMoney(feePlanDoc.amount, 12)
                        : feePlanDoc.frequency === 'Quarterly'
                            ? divMoney(feePlanDoc.amount, 3)
                            : feePlanDoc.amount)
                    : (route.defaultFeeAmount || studentDoc?.feeAmount || busMetrics?.avgMonthlyFeePerStudent || 2200)
        );
        if (direction === 'One-Way' || direction === 'Pickup-Only' || direction === 'Drop-Only') {
            if (feePlanDoc?.oneWayAmount > 0) {
                expectedMonthlyRevenue = roundMoney(feePlanDoc.oneWayAmount);
            }
        }

        // Variable cost per km for this bus (fuel + variable cost / km, fallback to school default)
        const busVariableCostPerKm = busMetrics && busMetrics.effectivePeriodKm > 0 && busMetrics.directVariableCost > 0
            ? Math.max(8, divMoney(busMetrics.directVariableCost, busMetrics.effectivePeriodKm))
            : defaultVarCostPerKm;

        const dailyDetourKm = direction === 'One-Way' || direction === 'Pickup-Only' || direction === 'Drop-Only'
            ? detour.detourOneWayKm
            : detour.detourRoundTripKm;

        const incrementalMonthlyKm = Number((dailyDetourKm * operatingDays).toFixed(2));
        const incrementalMonthlyCost = mulMoney(busVariableCostPerKm, incrementalMonthlyKm);
        const incrementalMonthlyContribution = subMoney(expectedMonthlyRevenue, incrementalMonthlyCost);

        const currentRouteContribution = busMetrics ? busMetrics.operatingContribution : 0;
        const projectedRouteContribution = addMoney(currentRouteContribution, incrementalMonthlyContribution);

        const availableAfter = Math.max(0, availableBefore - 1);
        const occupancyPercentAfter = usableCapacity > 0
            ? Number((((occupiedBefore + 1) / usableCapacity) * 100).toFixed(1))
            : 100;

        // Compute 5 normalized component scores (0 - 100 each)
        const proximityScore = Math.max(0, Math.min(100, Math.round((1 - detour.distanceFromRouteKm / Math.max(1, radiusLimit)) * 100)));
        const detourDistanceScore = Math.max(0, Math.min(100, Math.round((1 - dailyDetourKm / 10) * 100)));
        const addedTimeScore = Math.max(0, Math.min(100, Math.round((1 - detour.detourMinutes / Math.max(1, maxDetourMinutesPolicy)) * 100)));

        // Capacity health: sweet spot is 65%-90% after assignment, penalize >95% or <30%
        let capacityHealthScore = 80;
        if (availableBefore <= 0) capacityHealthScore = 0;
        else if (occupancyPercentAfter >= 65 && occupancyPercentAfter <= 88) capacityHealthScore = 95;
        else if (occupancyPercentAfter > 88 && occupancyPercentAfter <= 96) capacityHealthScore = 75;
        else if (occupancyPercentAfter > 96) capacityHealthScore = 55;
        else capacityHealthScore = 70;

        // Financial contribution score: ratio of incremental contribution to expected revenue
        const contribMarginRatio = expectedMonthlyRevenue > 0
            ? incrementalMonthlyContribution / expectedMonthlyRevenue
            : 0;
        const financialContributionScore = Math.max(0, Math.min(100, Math.round(contribMarginRatio * 100)));

        const totalWeight =
            (weights.routeProximity || 25) +
            (weights.detourDistanceEfficiency || 20) +
            (weights.addedTimeEfficiency || 20) +
            (weights.capacityHealth || 10) +
            (weights.incrementalFinancialContribution || 25);

        const weightedRaw =
            proximityScore * (weights.routeProximity || 25) +
            detourDistanceScore * (weights.detourDistanceEfficiency || 20) +
            addedTimeScore * (weights.addedTimeEfficiency || 20) +
            capacityHealthScore * (weights.capacityHealth || 10) +
            financialContributionScore * (weights.incrementalFinancialContribution || 25);

        const totalScore = feasible
            ? Number((weightedRaw / Math.max(1, totalWeight)).toFixed(1))
            : 0;

        const explanationReasons = [];
        if (feasible) {
            if (detour.boardsAtExistingStop) {
                explanationReasons.push(`Zero detour: Student is ${detour.distanceFromRouteKm} km from existing stop "${detour.nearestStop.stopName}"`);
            } else {
                explanationReasons.push(`${detour.distanceFromRouteKm} km from route; adds only +${dailyDetourKm} km/day (+${detour.detourMinutes} min)`);
            }
            explanationReasons.push(`${availableBefore} available seat(s) (${occupiedBefore}/${usableCapacity} -> ${occupancyPercentAfter}% occupancy after assignment)`);
            explanationReasons.push(
                `+₹${incrementalMonthlyContribution.toLocaleString('en-IN')}/mo net contribution (₹${expectedMonthlyRevenue.toLocaleString('en-IN')} fee - ₹${incrementalMonthlyCost.toLocaleString('en-IN')} incremental fuel/var cost)`
            );
            if (currentRouteContribution < 0 && projectedRouteContribution > currentRouteContribution) {
                explanationReasons.push(`Improves route deficit from ₹${currentRouteContribution.toLocaleString('en-IN')} to ₹${projectedRouteContribution.toLocaleString('en-IN')}`);
            }
        } else {
            explanationReasons.push(...rejectionReasons);
        }

        rawCandidates.push({
            busId: busObj?._id || null,
            busCode: busMetrics?.displayCode || busObj?.displayCode || busObj?.carNumber || 'Unassigned',
            busNumber: busMetrics?.displayCode || busObj?.displayCode || busObj?.carNumber || 'Unassigned',
            carNumber: busObj?.carNumber || 'Unassigned',
            routeId: route._id,
            routeName: route.name,
            routeCode: route.code || `RT-${String(route.name).slice(0, 3).toUpperCase()}`,
            shift: route.shift,
            feasible,
            eligible: feasible,
            rejectionReasons,
            boardsAtExistingStop: detour.boardsAtExistingStop,
            nearestStopName: detour.nearestStop?.stopName || 'New Pickup Point',
            nearestStopLat: detour.nearestStop?.lat || resolvedLat,
            nearestStopLng: detour.nearestStop?.lng || resolvedLng,
            insertAfterStopSequence: detour.insertAfterSequence,
            distanceFromRouteKm: detour.distanceFromRouteKm,
            detourKmPerDay: dailyDetourKm,
            detourKmOneWay: dailyDetourKm,
            detourMinutesPerDay: detour.detourMinutes,
            incrementalMonthlyKm,
            usableCapacity,
            occupiedSeatsBefore: occupiedBefore,
            availableSeatsBefore: availableBefore,
            availableSeatsAfter: availableAfter,
            occupancyPercentAfter,
            variableCostPerKmUsed: busVariableCostPerKm,
            expectedMonthlyRevenue,
            incrementalMonthlyRevenue: expectedMonthlyRevenue,
            incrementalMonthlyCost,
            incrementalMonthlyContribution,
            netMonthlyMarginImpact: incrementalMonthlyContribution,
            currentRouteRevenue: busMetrics?.periodRevenue || 0,
            currentRouteCost: busMetrics?.totalOperatingCost || 0,
            currentRouteContribution,
            projectedRouteContribution,
            beforeGeometry: detour.beforeGeometry,
            afterGeometry: detour.afterGeometry,
            stops: route.stops || [],
            scoreComponents: {
                proximityScore,
                detourDistanceScore,
                addedTimeScore,
                capacityHealthScore,
                financialContributionScore
            },
            scoreBreakdown: {
                proximity: proximityScore,
                detour: detourDistanceScore,
                seatAvailability: capacityHealthScore,
                routeProfitability: financialContributionScore,
                serviceWindow: addedTimeScore
            },
            totalScore,
            explanationReasons
        });
    }

    // Sort: Feasible first (by descending totalScore, then descending incrementalMonthlyContribution), then infeasible
    rawCandidates.sort((a, b) => {
        if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return b.incrementalMonthlyContribution - a.incrementalMonthlyContribution;
    });

    let feasibleRank = 1;
    const rankedCandidates = rawCandidates.map(c => ({
        ...c,
        rank: c.feasible ? feasibleRank++ : null
    }));

    const feasibleCandidates = rankedCandidates.filter(c => c.feasible);
    const bestMatch = feasibleCandidates.length > 0 ? feasibleCandidates[0] : null;

    // Diagnose no-match reason if no feasible candidate exists
    let noMatchDiagnostic = null;
    if (!bestMatch) {
        const allFull = rankedCandidates.length > 0 && rankedCandidates.every(c => c.availableSeatsBefore <= 0);
        const allOutsideRadius = rankedCandidates.length > 0 && rankedCandidates.every(c => c.distanceFromRouteKm > radiusLimit);
        noMatchDiagnostic = {
            reasonCode: rankedCandidates.length === 0
                ? 'NO_ROUTES_CONFIGURED'
                : allFull
                    ? 'ALL_NEARBY_BUSES_FULL'
                    : allOutsideRadius
                        ? 'NO_ROUTE_WITHIN_RADIUS'
                        : 'TIMING_OR_SHIFT_CONFLICT',
            message: rankedCandidates.length === 0
                ? 'No active school routes found. Please create routes first.'
                : allFull
                    ? 'Nearby routes exist, but all candidate buses are at 100% capacity. Full buses are shown below for context with confirmation disabled.'
                    : allOutsideRadius
                        ? `No active route passes within ${radiusLimit} km of this location. Try expanding the search radius.`
                        : 'Nearby routes conflicted with shift or maximum detour timing constraints.'
        };
    }

    let savedRun = null;
    if (saveRun) {
        savedRun = await OptimizationRun.create({
            company: companyId,
            student: studentId || null,
            studentName: studentName || 'New Admission Inquiry',
            inputAddress: inputAddress || `${resolvedLat}, ${resolvedLng}`,
            normalizedAddress: normalizedAddress || inputAddress,
            lat: resolvedLat,
            lng: resolvedLng,
            shift,
            searchRadiusKm: radiusLimit,
            weightsUsed: weights,
            candidates: rankedCandidates.map(c => ({
                busId: c.busId,
                busCode: c.busCode,
                carNumber: c.carNumber,
                routeId: c.routeId,
                routeName: c.routeName,
                feasible: c.feasible,
                rejectionReasons: c.rejectionReasons,
                nearestStopName: c.nearestStopName,
                insertAfterStopSequence: c.insertAfterStopSequence,
                distanceFromRouteKm: c.distanceFromRouteKm,
                detourKmPerDay: c.detourKmPerDay,
                detourMinutesPerDay: c.detourMinutesPerDay,
                usableCapacity: c.usableCapacity,
                occupiedSeatsBefore: c.occupiedSeatsBefore,
                availableSeatsBefore: c.availableSeatsBefore,
                availableSeatsAfter: c.availableSeatsAfter,
                occupancyPercentAfter: c.occupancyPercentAfter,
                expectedMonthlyRevenue: c.expectedMonthlyRevenue,
                incrementalMonthlyCost: c.incrementalMonthlyCost,
                incrementalMonthlyContribution: c.incrementalMonthlyContribution,
                currentRouteContribution: c.currentRouteContribution,
                projectedRouteContribution: c.projectedRouteContribution,
                scoreComponents: c.scoreComponents,
                totalScore: c.totalScore,
                rank: c.rank,
                explanationReasons: c.explanationReasons
            })),
            selectedBus: bestMatch?.busId || null,
            selectedRoute: bestMatch?.routeId || null,
            decisionStatus: bestMatch ? 'Evaluated' : 'NoMatch',
            actor: user?._id || null
        });
    }

    return {
        optimizationRunId: savedRun?._id || null,
        studentLocation: {
            studentId,
            studentName,
            inputAddress,
            normalizedAddress,
            lat: resolvedLat,
            lng: resolvedLng
        },
        schoolLocation: schoolPoint,
        weightsUsed: weights,
        bestMatch,
        topRecommendation: bestMatch,
        feasibleCount: feasibleCandidates.length,
        totalEvaluated: rankedCandidates.length,
        noMatchDiagnostic,
        candidates: rankedCandidates
    };
};

module.exports = {
    evaluateRouteRecommendations
};

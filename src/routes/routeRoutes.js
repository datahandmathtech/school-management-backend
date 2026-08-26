const express = require('express');
const router = express.Router();
const {
    getRoutes,
    createRoute,
    updateRoute,
    deleteRoute,
    findNearestRoute,
    optimizeRoute
} = require('../controllers/routeController');
const { protect, adminOrExecutive } = require('../middleware/authMiddleware');

router.use(protect);
router.use(adminOrExecutive);

router.route('/')
    .post(createRoute);

router.route('/nearest/:companyId')
    .post(findNearestRoute);

router.route('/optimize/:id')
    .post(optimizeRoute);

router.route('/:companyId')
    .get(getRoutes);

router.route('/:id')
    .put(updateRoute)
    .delete(deleteRoute);

module.exports = router;

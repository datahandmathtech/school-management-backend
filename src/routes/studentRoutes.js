const express = require('express');
const router = express.Router();
const {
    getStudents,
    createStudent,
    updateStudent,
    deleteStudent
} = require('../controllers/studentController');
const { protect, adminOrExecutive } = require('../middleware/authMiddleware');

router.use(protect);
router.use(adminOrExecutive);

router.route('/')
    .post(createStudent);

router.route('/:companyId')
    .get(getStudents);

router.route('/:id')
    .put(updateStudent)
    .delete(deleteStudent);

module.exports = router;

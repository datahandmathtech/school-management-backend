const express = require('express');
const router = express.Router();
const AcademicClass = require('../models/AcademicClass');
const { protect } = require('../middleware/authMiddleware');

// Get all classes for a company
router.get('/:companyId', protect, async (req, res) => {
    try {
        const classes = await AcademicClass.find({ company: req.params.companyId }).sort('className');
        res.json(classes);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Create a new class
router.post('/', protect, async (req, res) => {
    const { className, sections, company } = req.body;
    try {
        const newClass = await AcademicClass.create({ className, sections, company });
        res.status(201).json(newClass);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Class already exists' });
        }
        res.status(400).json({ message: err.message });
    }
});

// Update a class
router.put('/:id', protect, async (req, res) => {
    try {
        const updatedClass = await AcademicClass.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updatedClass);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Delete a class
router.delete('/:id', protect, async (req, res) => {
    try {
        await AcademicClass.findByIdAndDelete(req.params.id);
        res.json({ message: 'Class deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;

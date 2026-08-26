const mongoose = require('mongoose');

const academicClassSchema = new mongoose.Schema({
    className: {
        type: String,
        required: true
    },
    sections: [{
        type: String
    }],
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    }
}, { timestamps: true });

// Prevent duplicate class names per company
academicClassSchema.index({ className: 1, company: 1 }, { unique: true });

module.exports = mongoose.model('AcademicClass', academicClassSchema);

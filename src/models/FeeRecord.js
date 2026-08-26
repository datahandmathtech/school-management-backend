const mongoose = require('mongoose');

const feeRecordSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true
    },
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true
    },
    month: {
        type: String, // e.g., 'August'
        required: true
    },
    year: {
        type: Number, // e.g., 2026
        required: true
    },
    amountPaid: {
        type: Number,
        default: 0
    },
    amountPending: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['Paid', 'Partial', 'Pending'],
        default: 'Pending'
    },
    paymentDate: {
        type: Date
    }
}, { timestamps: true });

feeRecordSchema.index({ student: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('FeeRecord', feeRecordSchema);

const mongoose = require('mongoose');
const { moneyField } = require('../utils/moneyUtils');

const transportLedgerEntrySchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        required: true,
        index: true
    },
    entryDate: {
        type: Date,
        required: true,
        default: Date.now,
        index: true
    },
    periodKey: {
        type: String,
        required: true,
        index: true
    },
    entryType: {
        type: String,
        enum: [
            'OpeningBalance',
            'Demand',
            'Receipt',
            'AdvanceAllocation',
            'CreditAdjustment',
            'DebitAdjustment',
            'Waiver',
            'Refund',
            'DemandReversal',
            'ReceiptReversal'
        ],
        required: true
    },
    referenceType: {
        type: String,
        default: 'TransportDemand'
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null
    },
    referenceNo: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        required: true
    },
    debit: moneyField(0),   // Increases student receivable (Demand, DebitAdjustment, Refund of advance)
    credit: moneyField(0),  // Reduces student receivable (Receipt, CreditAdjustment, Waiver)
    runningBalance: moneyField(0),
    reason: {
        type: String,
        default: ''
    },
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

transportLedgerEntrySchema.index({ company: 1, student: 1, entryDate: 1, createdAt: 1 });

module.exports = mongoose.model('TransportLedgerEntry', transportLedgerEntrySchema);

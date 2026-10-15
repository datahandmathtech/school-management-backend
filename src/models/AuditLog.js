const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    actorName: {
        type: String,
        default: 'System'
    },
    actorRole: {
        type: String,
        default: 'System'
    },
    action: {
        type: String,
        required: true,
        index: true
    },
    entityType: {
        type: String,
        required: true,
        index: true
    },
    entityId: {
        type: String,
        default: null
    },
    beforeState: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    afterState: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    reason: {
        type: String,
        default: ''
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

auditLogSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);

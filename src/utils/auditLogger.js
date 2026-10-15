const AuditLog = require('../models/AuditLog');

const logAudit = async ({
    company,
    user,
    action,
    entityType,
    entityId = null,
    beforeState = null,
    afterState = null,
    reason = '',
    metadata = {}
}) => {
    try {
        if (!company) return null;
        return await AuditLog.create({
            company,
            actor: user?._id || null,
            actorName: user?.name || 'System',
            actorRole: user?.role || 'System',
            action,
            entityType,
            entityId: entityId ? String(entityId) : null,
            beforeState,
            afterState,
            reason,
            metadata
        });
    } catch (err) {
        console.error('AuditLog write error:', err.message);
        return null;
    }
};

module.exports = { logAudit };

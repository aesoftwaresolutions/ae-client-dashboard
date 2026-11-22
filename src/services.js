'use strict';
// The 17 AE services, their event types and status rules.
// Event lists follow the tracking matrix (plain client-facing language).
// Older event names are kept alongside the matrix names so existing stored
// events keep working; new events use the matrix names.

const FD_EVENTS = ['setup_complete', 'call_answered', 'call_missed', 'call_summary', 'appointment_booked', 'call_transferred', 'plan_limit_warning'];
const OPM_EVENTS = ['profile_updated', 'review_received', 'review_replied', 'listing_fixed', 'check_completed', 'negative_review_flagged'];

const SERVICES = [
  { slug: 'front-desk', name: 'Front Desk', kind: 'calls', events: FD_EVENTS },
  { slug: 'always-on-front-desk', name: 'Always-On Front Desk', kind: 'calls',
    events: ['setup_complete', 'call_answered', 'call_missed', 'call_summary', 'after_hours_call_answered', 'after_hours_call', 'callback_requested', 'plan_limit_warning'] },
  { slug: 'websites', name: 'Websites', events: ['milestone_completed', 'milestone_reached', 'review_ready', 'site_launched', 'maintenance_update', 'revision_requested', 'revision_complete'] },
  { slug: 'online-presence-management', name: 'Online Presence Management', kind: 'presence', events: OPM_EVENTS },
  { slug: 'missed-lead-audit', name: 'Missed-Lead Audit', events: ['audit_scheduled', 'audit_in_progress', 'audit_started', 'report_ready', 'credit_applied'] },
  { slug: 'launch-package', name: 'Launch Package', events: ['setup_started', 'deliverable_ready', 'setup_complete', 'checklist_item_done', 'launch_complete'] },
  { slug: 'social-front-desk', name: 'Social Front Desk', events: ['setup_complete', 'message_answered', 'comment_replied', 'response_time_update'] },
  // Total Presence = Social Front Desk + Google Business Profile; it reuses front-desk and OPM event types.
  { slug: 'total-presence', name: 'Total Presence', events: [...FD_EVENTS, ...OPM_EVENTS, 'monthly_summary_sent'] },
  { slug: 'social-management', name: 'Social Management', events: ['post_scheduled', 'post_published', 'engagement_summary', 'report_ready'] },
  { slug: 'creator-packages', name: 'Creator Packages', events: ['asset_in_review', 'post_published', 'report_ready', 'content_published', 'deliverable_ready', 'growth_summary'] },
  { slug: 'free-assessment', name: 'Free Operational Assessment', events: ['assessment_started', 'report_ready'] },
  { slug: 'business-starter-package', name: 'Business Starter Package', events: ['setup_complete', 'resource_updated', 'crm_ready', 'invoice_sent', 'guide_added'] },
  { slug: 'branded-templates', name: 'Branded Document Templates', events: ['draft_ready', 'deliverable_ready', 'setup_complete', 'templates_delivered'] },
  { slug: 'ai-tools-assessment', name: 'AI Tools Assessment', events: ['assessment_started', 'report_ready'] },
  { slug: 'ai-setup-guides', name: 'AI Setup Guides Subscription', events: ['setup_complete', 'guide_published'] },
  { slug: 'contractor-guides', name: 'Contractor PDF Guides', events: ['guide_downloaded', 'guide_published', 'guide_delivered'] },
  { slug: 'order-desk', name: 'Order Desk', kind: 'orders', events: ['setup_complete', 'order_received', 'order_pending_approval', 'order_approved', 'pricing_report_ready', 'plan_limit_warning'] },
];

const BY_SLUG = new Map(SERVICES.map((s) => [s.slug, s]));

// Plain-language status labels (spec 4.1).
const STATUS_LABELS = {
  active: 'Active',
  setting_up: 'Setting up',
  attention: 'Attention needed',
  paused: 'Paused',
  ended: 'Ended',
};

// Spec 5.3: these events move the card status. All other event types, including
// unknown ones, are stored and shown but never change the status.
const STATUS_EVENTS = {
  setup_complete: 'active',
  site_launched: 'active',
  report_ready: 'active',
  plan_limit_warning: 'attention',
};

// Derivation only touches cards that are in a "live" state. Paused/Ended are set by
// AE (admin override) and must not be flipped by an incoming event.
const DERIVABLE_FROM = new Set(['setting_up', 'active', 'attention']);

module.exports = { SERVICES, BY_SLUG, STATUS_LABELS, STATUS_EVENTS, DERIVABLE_FROM };

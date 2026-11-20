'use strict';
// The 16 AE services (spec 4.1), their event types (spec 5.2) and status rules (spec 5.3).

const FD_EVENTS = ['call_answered', 'call_missed', 'call_summary', 'plan_limit_warning', 'setup_complete'];
const OPM_EVENTS = ['profile_updated', 'review_received', 'review_replied', 'listing_fixed', 'check_completed'];

const SERVICES = [
  { slug: 'websites', name: 'Websites', events: ['milestone_reached', 'site_launched', 'revision_requested', 'revision_complete'] },
  { slug: 'online-presence-management', name: 'Online Presence Management', events: OPM_EVENTS },
  { slug: 'front-desk', name: 'Front Desk', kind: 'calls', events: FD_EVENTS },
  { slug: 'always-on-front-desk', name: 'Always-On Front Desk', kind: 'calls',
    events: ['call_answered', 'call_missed', 'call_summary', 'after_hours_call', 'setup_complete'] },
  { slug: 'missed-lead-audit', name: 'Missed-Lead Audit', events: ['audit_scheduled', 'audit_started', 'report_ready'] },
  { slug: 'launch-package', name: 'Launch Package', events: ['checklist_item_done', 'launch_complete'] },
  { slug: 'social-front-desk', name: 'Social Front Desk', events: ['message_answered', 'comment_replied', 'response_time_update'] },
  // Total Presence = Social Front Desk + Google Business Profile; it reuses front-desk and OPM event types.
  { slug: 'total-presence', name: 'Total Presence', events: [...FD_EVENTS, ...OPM_EVENTS] },
  { slug: 'social-management', name: 'Social Management', events: ['post_published', 'post_scheduled', 'engagement_summary', 'report_ready'] },
  { slug: 'creator-packages', name: 'Creator Packages', events: ['content_published', 'deliverable_ready', 'growth_summary'] },
  { slug: 'free-assessment', name: 'Free Operational Assessment', events: ['assessment_started', 'report_ready'] },
  { slug: 'business-starter-package', name: 'Business Starter Package', events: ['crm_ready', 'invoice_sent', 'guide_added'] },
  { slug: 'branded-templates', name: 'Branded Document Templates', events: ['templates_delivered'] },
  { slug: 'ai-tools-assessment', name: 'AI Tools Assessment', events: ['assessment_started', 'report_ready'] },
  { slug: 'ai-setup-guides', name: 'AI Setup Guides Subscription', events: ['guide_published'] },
  { slug: 'contractor-guides', name: 'Contractor PDF Guides', events: ['guide_delivered'] },
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

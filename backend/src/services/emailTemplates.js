const db = require('../db');
const { getHardcodedDefaults } = require('./templates');

// Insert a starter "Default" template on first boot so the dashboard has
// something to show and so existing campaigns (with template_id = NULL)
// keep getting the legacy outreach + 48h follow-up out of the box.
async function seedDefaultIfEmpty() {
  const existing = await db.one(`SELECT id FROM email_templates LIMIT 1`);
  if (existing) return;
  const d = getHardcodedDefaults();
  const followups = [{
    delayHours: 48,
    label: 'First bump',
    subject: d.followup.subject,
    body: d.followup.body,
  }];
  await db.query(
    `INSERT INTO email_templates (name, outreach, followups, is_default)
     VALUES ($1, $2::jsonb, $3::jsonb, TRUE)`,
    ['Default', JSON.stringify(d.outreach), JSON.stringify(followups)],
  );
  console.log('Seeded Default email template');
}

// Returns the template that applies to a given campaign row: the campaign's
// explicit template_id, or the row marked is_default, or null.
async function getActiveTemplateForCampaign(campaignId) {
  return db.one(
    `SELECT et.*
     FROM campaigns ca
     LEFT JOIN email_templates et
       ON et.id = COALESCE(
         ca.template_id,
         (SELECT id FROM email_templates WHERE is_default LIMIT 1)
       )
     WHERE ca.id = $1`,
    [campaignId],
  );
}

module.exports = { seedDefaultIfEmpty, getActiveTemplateForCampaign };

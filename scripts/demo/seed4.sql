-- Northside Interiors DEMO — part 4: automations, flows, forms, broadcasts, channels
\set ACC '''39795c53-4a45-43a2-acec-5cff48a889e1'''
\set OWN '''8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3'''
\set SIVA '''396afb78-ef6b-442a-84d5-5074afd23efe'''

BEGIN;

-- ======================================================== AUTOMATIONS
INSERT INTO automations (id, user_id, account_id, name, description, trigger_type,
                         trigger_config, channels, is_active, execution_count, last_executed_at) VALUES
 ('ae000001-0000-4000-8000-000000000001',:OWN,:ACC,'New enquiry — greet & tag',
  'First message on any channel gets an instant reply and lands as a lead.',
  'first_inbound_message','{}'::jsonb, ARRAY['whatsapp','instagram','web'], true, 214, now()-interval '25 minutes'),
 ('ae000002-0000-4000-8000-000000000002',:OWN,:ACC,'Keyword: PRICE → send rate card',
  'Anyone asking about price gets the starting ranges straight away.',
  'keyword_match','{"keywords":["price","cost","rate","quotation","how much"],"match":"any"}'::jsonb,
  ARRAY['whatsapp','instagram','web'], true, 87, now()-interval '90 minutes'),
 ('ae000003-0000-4000-8000-000000000003',:OWN,:ACC,'Site visit booked → prep the designer',
  'Books the slot, tags the contact and notifies the assigned designer.',
  'appointment_booked','{}'::jsonb, ARRAY[]::text[], true, 41, now()-interval '40 minutes'),
 ('ae000004-0000-4000-8000-000000000004',:OWN,:ACC,'Website form → create deal',
  'Every website enquiry becomes a contact and a deal in New Lead.',
  'form_submitted','{}'::jsonb, ARRAY[]::text[], true, 63, now()-interval '9 hours'),
 ('ae000005-0000-4000-8000-000000000005',:OWN,:ACC,'Quote sent — 3 day nudge',
  'If a quote has not been answered in 3 days, send one polite follow-up.',
  'tag_added','{"tag":"Follow up"}'::jsonb, ARRAY['whatsapp'], false, 12, now()-interval '11 days');

INSERT INTO automation_steps (automation_id, key, step_type, step_config, position, parent_step_id, branch, position_x, position_y) VALUES
 -- 1: greet & tag, with a channel branch
 ('ae000001-0000-4000-8000-000000000001','greet','send_message',
  '{"text":"Hi {{contact.name | default:\"there\"}}! Thanks for reaching out to Northside Interiors 👋 What are you planning — a full home, a kitchen, or something smaller?"}'::jsonb, 0, NULL, NULL, 240, 40),
 ('ae000001-0000-4000-8000-000000000001','tag_lead','add_tag','{"tag":"Hot lead"}'::jsonb, 1, NULL, NULL, 240, 200),
 ('ae000001-0000-4000-8000-000000000001','is_instagram','condition',
  '{"match":"all","rules":[{"subject":"conversation.channel","operand":"equals","value":"instagram"}]}'::jsonb, 2, NULL, NULL, 240, 360),
 ('ae000001-0000-4000-8000-000000000001','seg_social','add_to_segment',
  '{"segment_id":"5e000001-0000-4000-8000-000000000001"}'::jsonb, 0,
  (SELECT id FROM automation_steps WHERE automation_id='ae000001-0000-4000-8000-000000000001' AND key='is_instagram'),'yes', 60, 520),
 ('ae000001-0000-4000-8000-000000000001','note_web','add_note',
  '{"text":"Came in via {{conversation.channel}}"}'::jsonb, 0,
  (SELECT id FROM automation_steps WHERE automation_id='ae000001-0000-4000-8000-000000000001' AND key='is_instagram'),'no', 420, 520),
 -- 2: rate card
 ('ae000002-0000-4000-8000-000000000002','rates','send_message',
  '{"text":"Happy to help! Our starting points:\n\n• Modular kitchen — ₹1,650 / sqft\n• Wardrobes — ₹1,400 / sqft\n• Full home (3BHK) — ₹12L to ₹18L\n\nAll modular work carries a 5-year warranty. Want a free site visit?"}'::jsonb, 0, NULL, NULL, 240, 40),
 ('ae000002-0000-4000-8000-000000000002','tag_price','add_tag','{"tag":"Hot lead"}'::jsonb, 1, NULL, NULL, 240, 200),
 -- 3: booking
 ('ae000003-0000-4000-8000-000000000003','confirm','send_message',
  '{"text":"You are booked for {{trigger.starts_at}} ✅ Our designer will call 30 minutes before. Reply RESCHEDULE if you need to move it."}'::jsonb, 0, NULL, NULL, 240, 40),
 ('ae000003-0000-4000-8000-000000000003','tag_visit','add_tag','{"tag":"Site visit done"}'::jsonb, 1, NULL, NULL, 240, 200),
 ('ae000003-0000-4000-8000-000000000003','tell_team','notify_team',
  '{"message":"Site visit booked: {{contact.name}} — {{trigger.starts_at}}"}'::jsonb, 2, NULL, NULL, 240, 360),
 -- 4: form → deal
 ('ae000004-0000-4000-8000-000000000004','make_deal','create_deal',
  '{"pipeline_id":"b1000001-0000-4000-8000-000000000001","stage_id":"b2000001-0000-4000-8000-000000000001","title":"{{form.project_type}} — {{contact.name}}"}'::jsonb, 0, NULL, NULL, 240, 40),
 ('ae000004-0000-4000-8000-000000000004','ack','send_message',
  '{"text":"Thanks {{contact.name}}! We have your enquiry and a designer will be in touch within one working day."}'::jsonb, 1, NULL, NULL, 240, 200),
 ('ae000004-0000-4000-8000-000000000004','sync_sheet','google_action',
  '{"action":"sheet_append","fields":{"spreadsheet_id":"DEMO_SHEET_ID","tab":"Website leads","values":["{{now}}","{{contact.name}}","{{contact.phone}}","{{form.project_type}}"]}}'::jsonb, 2, NULL, NULL, 240, 360),
 -- 5: nudge
 ('ae000005-0000-4000-8000-000000000005','wait3','wait','{"duration":3,"unit":"days"}'::jsonb, 0, NULL, NULL, 240, 40),
 ('ae000005-0000-4000-8000-000000000005','nudge','send_template',
  '{"template_name":"quote_followup","language":"en"}'::jsonb, 1, NULL, NULL, 240, 200);

-- ============================================================== FLOWS
INSERT INTO flows (id, user_id, account_id, name, description, status, trigger_type,
                   trigger_config, entry_node_id, execution_count, last_executed_at) VALUES
 ('f1000001-0000-4000-8000-000000000001',:OWN,:ACC,'Enquiry qualifier',
  'Asks what they are planning, captures budget, then books or hands off.',
  'active','first_inbound_message','{}'::jsonb,'start', 189, now()-interval '25 minutes'),
 ('f1000002-0000-4000-8000-000000000002',:OWN,:ACC,'Catalogue browser',
  'Keyword CATALOGUE — shows the product range and captures interest.',
  'active','keyword',
  '{"keywords":["catalogue","catalog","brochure","designs"]}'::jsonb,'start', 54, now()-interval '2 days'),
 ('f1000003-0000-4000-8000-000000000003',:OWN,:ACC,'Post-install feedback',
  'Sent a week after handover to collect a rating.',
  'draft','manual','{}'::jsonb,'start', 0, NULL);

INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y) VALUES
 -- flow 1
 ('f1000001-0000-4000-8000-000000000001','start','start','{"next_node_key":"ask_type"}'::jsonb, 80, 40),
 ('f1000001-0000-4000-8000-000000000001','ask_type','send_buttons',
  '{"text":"Hi! What are you planning?","buttons":[{"id":"full","title":"Full home"},{"id":"kitchen","title":"Kitchen"},{"id":"other","title":"Something else"}],"next_node_key":"ask_budget"}'::jsonb, 80, 180),
 ('f1000001-0000-4000-8000-000000000001','ask_budget','send_list',
  '{"header":"Budget","body":"Roughly what budget are you working with?","button":"Choose","sections":[{"title":"Ranges","rows":[{"id":"u5","title":"Under ₹5L"},{"id":"5_10","title":"₹5L - ₹10L"},{"id":"10_20","title":"₹10L - ₹20L"},{"id":"20p","title":"₹20L+"}]}],"next_node_key":"check_budget"}'::jsonb, 80, 340),
 ('f1000001-0000-4000-8000-000000000001','check_budget','condition',
  '{"match":"any","rules":[{"subject":"vars.budget","operand":"equals","value":"10_20"},{"subject":"vars.budget","operand":"equals","value":"20p"}],"true_node_key":"tag_hot","false_node_key":"send_ranges"}'::jsonb, 80, 500),
 ('f1000001-0000-4000-8000-000000000001','tag_hot','set_tag','{"tag":"Hot lead","next_node_key":"offer_visit"}'::jsonb, -120, 660),
 ('f1000001-0000-4000-8000-000000000001','offer_visit','send_buttons',
  '{"text":"Lovely. Shall I book a free site visit?","buttons":[{"id":"yes","title":"Yes please"},{"id":"later","title":"Maybe later"}],"next_node_key":"handoff"}'::jsonb, -120, 800),
 ('f1000001-0000-4000-8000-000000000001','send_ranges','send_message',
  '{"text":"No problem — here is what we can do in that range. A designer will follow up with options.","next_node_key":"handoff"}'::jsonb, 300, 660),
 ('f1000001-0000-4000-8000-000000000001','handoff','handoff','{"message":"Handing you to one of our designers now."}'::jsonb, 80, 960),
 -- flow 2
 ('f1000002-0000-4000-8000-000000000002','start','start','{"next_node_key":"intro"}'::jsonb, 80, 40),
 ('f1000002-0000-4000-8000-000000000002','intro','send_message',
  '{"text":"Here is our current range 👇","next_node_key":"products"}'::jsonb, 80, 180),
 ('f1000002-0000-4000-8000-000000000002','products','send_products',
  '{"catalog_id":"DEMO_CATALOG","product_ids":["NSI-KIT-01","NSI-WRD-01","NSI-TV-01"],"next_node_key":"ask_interest"}'::jsonb, 80, 320),
 ('f1000002-0000-4000-8000-000000000002','ask_interest','collect_input',
  '{"prompt":"Anything catch your eye? Tell me which one and I will send details.","variable":"interest","next_node_key":"tag_it"}'::jsonb, 80, 460),
 ('f1000002-0000-4000-8000-000000000002','tag_it','set_attribute',
  '{"field":"company","value":"{{vars.interest}}","next_node_key":"done"}'::jsonb, 80, 600),
 ('f1000002-0000-4000-8000-000000000002','done','end','{}'::jsonb, 80, 740),
 -- flow 3 (draft)
 ('f1000003-0000-4000-8000-000000000003','start','start','{"next_node_key":"ask_rating"}'::jsonb, 80, 40),
 ('f1000003-0000-4000-8000-000000000003','ask_rating','send_buttons',
  '{"text":"How did we do? ⭐","buttons":[{"id":"5","title":"Excellent"},{"id":"3","title":"Okay"},{"id":"1","title":"Not great"}],"next_node_key":"thanks"}'::jsonb, 80, 180),
 ('f1000003-0000-4000-8000-000000000003','thanks','send_message','{"text":"Thank you! That really helps us."}'::jsonb, 80, 320);

-- ============================================================== FORMS
INSERT INTO forms (id, account_id, user_id, name, description, slug, kind, status,
                   fields, settings, notify, submission_count, availability) VALUES
 ('f0000001-0000-4000-8000-000000000001', :ACC, :OWN, 'Get a free quote',
  'Website enquiry form — lands as a deal in New Lead.', 'free-quote', 'form', 'published',
  '[
    {"field_key":"name","type":"text","label":"Your name","required":true,"width":"half","mapping":"name"},
    {"field_key":"phone","type":"phone","label":"WhatsApp number","required":true,"width":"half","mapping":"phone"},
    {"field_key":"email","type":"email","label":"Email","required":false,"width":"full","mapping":"email"},
    {"field_key":"project_type","type":"select","label":"What are you planning?","required":true,
      "options":[{"value":"full_home","label":"Full home interiors"},{"value":"kitchen","label":"Modular kitchen"},{"value":"wardrobe","label":"Wardrobes"},{"value":"office","label":"Office fit-out"},{"value":"other","label":"Something else"}]},
    {"field_key":"other_detail","type":"text","label":"Tell us a bit more","required":true,
      "visible_when":{"field_key":"project_type","operator":"equals","value":"other"}},
    {"field_key":"budget","type":"select","label":"Budget range",
      "options":[{"value":"u5","label":"Under ₹5L"},{"value":"5_10","label":"₹5L - ₹10L"},{"value":"10_20","label":"₹10L - ₹20L"},{"value":"20p","label":"₹20L+"}]},
    {"field_key":"locality","type":"text","label":"Which part of the city?"},
    {"field_key":"consent","type":"consent","label":"I agree to be contacted on WhatsApp","required":true}
  ]'::jsonb,
  '{"submit_label":"Get my quote","honeypot":true,"theme":{"scheme":"light","accent":"#0f766e"}}'::jsonb,
  '{"in_app":true,"email":true}'::jsonb, 63, NULL),
 ('f0000002-0000-4000-8000-000000000002', :ACC, :OWN, 'Book a site visit',
  'Free 45-minute site visit with a designer.', 'site-visit', 'booking', 'published',
  '[
    {"field_key":"name","type":"text","label":"Your name","required":true,"width":"half","mapping":"name"},
    {"field_key":"phone","type":"phone","label":"WhatsApp number","required":true,"width":"half","mapping":"phone"},
    {"field_key":"address","type":"textarea","label":"Site address","required":true},
    {"field_key":"slot","type":"appointment_slot","label":"Pick a time","required":true},
    {"field_key":"notes","type":"textarea","label":"Anything we should know?"}
  ]'::jsonb,
  '{"submit_label":"Confirm my visit","honeypot":true,"theme":{"scheme":"light","accent":"#0f766e"}}'::jsonb,
  '{"in_app":true,"email":true}'::jsonb, 41,
  '{"timezone":"Asia/Kolkata","slot_minutes":45,"buffer_minutes":30,"min_notice_hours":12,"capacity":1,
    "hours":{"mon":[["10:00","18:00"]],"tue":[["10:00","18:00"]],"wed":[["10:00","18:00"]],"thu":[["10:00","18:00"]],"fri":[["10:00","18:00"]],"sat":[["10:00","15:00"]],"sun":[]}}'::jsonb);

INSERT INTO form_submissions (id, account_id, form_id, contact_id, data, source, status, created_at) VALUES
 ('f5000001-0000-4000-8000-000000000001',:ACC,'f0000001-0000-4000-8000-000000000001','aaaa0036-0000-4000-8000-000000000036',
  '{"name":"Neha Bansal","phone":"+919876500136","email":"neha.bansal@gmail.com","project_type":"full_home","budget":"10_20","locality":"Hebbal","consent":true}'::jsonb,'web','new',now()-interval '4 days'),
 ('f5000002-0000-4000-8000-000000000002',:ACC,'f0000001-0000-4000-8000-000000000001','aaaa0033-0000-4000-8000-000000000033',
  '{"name":"Vishal Nambiar","phone":"+919876500133","project_type":"kitchen","budget":"5_10","locality":"JP Nagar","consent":true}'::jsonb,'web','new',now()-interval '7 days'),
 ('f5000003-0000-4000-8000-000000000003',:ACC,'f0000001-0000-4000-8000-000000000001','aaaa0025-0000-4000-8000-000000000025',
  '{"name":"Ritu Agarwal","phone":"+919876500125","email":"ritu.agarwal@gmail.com","project_type":"other","other_detail":"Balcony decking and planters","budget":"u5","locality":"Indiranagar","consent":true}'::jsonb,'web','new',now()-interval '15 days'),
 ('f5000004-0000-4000-8000-000000000004',:ACC,'f0000002-0000-4000-8000-000000000002','aaaa0031-0000-4000-8000-000000000031',
  '{"name":"Rahul Verma","phone":"+919876500131","address":"Flat 402, Prestige Ferns, Harlur Road","notes":"Please call before coming up."}'::jsonb,'web','new',now()-interval '9 days');

INSERT INTO form_bookings (account_id, form_id, submission_id, contact_id, starts_at, ends_at,
                           timezone, status, manage_token, notes) VALUES
 (:ACC,'f0000002-0000-4000-8000-000000000002','f5000004-0000-4000-8000-000000000004','aaaa0031-0000-4000-8000-000000000031',
  date_trunc('hour', now())+interval '2 days'+interval '10 hours', date_trunc('hour', now())+interval '2 days'+interval '10 hours 45 minutes',
  'Asia/Kolkata','confirmed','demo-manage-token-0001','Please call before coming up.'),
 (:ACC,'f0000002-0000-4000-8000-000000000002',NULL,'aaaa0036-0000-4000-8000-000000000036',
  date_trunc('hour', now())+interval '1 day'+interval '6 hours', date_trunc('hour', now())+interval '1 day'+interval '6 hours 45 minutes',
  'Asia/Kolkata','confirmed','demo-manage-token-0002',NULL),
 (:ACC,'f0000002-0000-4000-8000-000000000002',NULL,'aaaa0023-0000-4000-8000-000000000023',
  date_trunc('hour', now())-interval '5 days', date_trunc('hour', now())-interval '5 days'+interval '45 minutes',
  'Asia/Kolkata','completed','demo-manage-token-0003',NULL),
 (:ACC,'f0000002-0000-4000-8000-000000000002',NULL,'aaaa0010-0000-4000-8000-000000000010',
  date_trunc('hour', now())-interval '12 days', date_trunc('hour', now())-interval '12 days'+interval '45 minutes',
  'Asia/Kolkata','cancelled','demo-manage-token-0004','Client postponed.');

-- ========================================================== TEMPLATES
INSERT INTO message_templates (account_id, user_id, name, category, language, header_type,
  header_content, body_text, footer_text, buttons, status, quality_score, meta_template_id, last_submitted_at) VALUES
 (:ACC,:OWN,'quote_followup','Utility','en','text','Your quote from Northside',
  'Hi {{1}}, just checking in on the quote we sent for your {{2}}. Happy to walk you through it or adjust anything — shall I call?',
  'Northside Interiors','[{"type":"QUICK_REPLY","text":"Call me"},{"type":"QUICK_REPLY","text":"Send revised"}]'::jsonb,
  'APPROVED','GREEN','1000000000000001', now()-interval '60 days'),
 (:ACC,:OWN,'site_visit_reminder','Utility','en','text','Site visit tomorrow',
  'Hi {{1}}, reminder that your free site visit is tomorrow at {{2}}. Our designer will call 30 minutes before.',
  'Northside Interiors','[{"type":"QUICK_REPLY","text":"Confirm"},{"type":"QUICK_REPLY","text":"Reschedule"}]'::jsonb,
  'APPROVED','GREEN','1000000000000002', now()-interval '58 days'),
 (:ACC,:OWN,'monsoon_offer_2026','Marketing','en','text','Monsoon offer',
  'Hi {{1}}! Book your modular kitchen before 30th September and we will include the German soft-close hardware free — worth ₹48,000.',
  'Reply STOP to opt out','[{"type":"URL","text":"See designs","url":"https://example.com/designs"}]'::jsonb,
  'APPROVED','GREEN','1000000000000003', now()-interval '40 days'),
 (:ACC,:OWN,'handover_thanks','Utility','en',NULL,NULL,
  'Hi {{1}}, your project is complete 🎉 Your 5-year warranty is active from today. We would love a quick review if you have a minute.',
  'Northside Interiors',NULL,'APPROVED','GREEN','1000000000000004', now()-interval '35 days'),
 (:ACC,:OWN,'festive_catalogue_2026','Marketing','en','text','New catalogue',
  'Hi {{1}}, our festive catalogue is out — 14 new kitchen finishes and a new wardrobe range. Want me to send it across?',
  'Reply STOP to opt out',NULL,'PENDING',NULL,NULL, now()-interval '2 days'),
 (:ACC,:OWN,'payment_reminder','Utility','en',NULL,NULL,
  'Hi {{1}}, a gentle reminder that the second instalment of {{2}} is due on {{3}}.',
  'Northside Interiors',NULL,'DRAFT',NULL,NULL,NULL);

-- ========================================================= BROADCASTS
INSERT INTO broadcasts (id, user_id, account_id, name, template_name, template_language,
  audience_filter, status, total_recipients, sent_count, delivered_count, read_count,
  replied_count, failed_count, scheduled_at, created_at) VALUES
 ('bd000001-0000-4000-8000-000000000001',:OWN,:ACC,'Monsoon offer — hot leads','monsoon_offer_2026','en',
  '{"type":"segments","segmentIds":["5e000003-0000-4000-8000-000000000003"]}'::jsonb,
  'sent', 9, 9, 9, 7, 3, 0, NULL, now()-interval '12 days'),
 ('bd000002-0000-4000-8000-000000000002',:OWN,:ACC,'Festive catalogue — all contacts','festive_catalogue_2026','en',
  '{"type":"all","excludeSegmentIds":["5e000002-0000-4000-8000-000000000002"]}'::jsonb,
  'sent', 34, 34, 33, 21, 6, 1, NULL, now()-interval '5 days'),
 ('bd000003-0000-4000-8000-000000000003',:OWN,:ACC,'Kitchen interest — follow up','quote_followup','en',
  '{"type":"segments","segmentIds":["5e000004-0000-4000-8000-000000000004"]}'::jsonb,
  'scheduled', 6, 0, 0, 0, 0, 0, now()+interval '2 days', now()-interval '1 day'),
 ('bd000004-0000-4000-8000-000000000004',:OWN,:ACC,'Architect partner update','handover_thanks','en',
  '{"type":"segments","segmentIds":["5e000002-0000-4000-8000-000000000002"]}'::jsonb,
  'draft', 0, 0, 0, 0, 0, 0, NULL, now()-interval '3 hours');

INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, sent_at, delivered_at, read_at, replied_at)
SELECT 'bd000001-0000-4000-8000-000000000001', c.id,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 3 THEN 'replied'
            WHEN row_number() OVER (ORDER BY c.created_at) <= 7 THEN 'read'
            ELSE 'delivered' END,
       now()-interval '12 days', now()-interval '12 days'+interval '4 seconds',
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 7 THEN now()-interval '12 days'+interval '20 minutes' ELSE NULL END,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 3 THEN now()-interval '12 days'+interval '45 minutes' ELSE NULL END
FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
JOIN tags t ON t.id=ct.tag_id AND t.name='Hot lead' AND t.account_id=:ACC
WHERE c.account_id=:ACC;

INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, sent_at, delivered_at, read_at, replied_at, error_message)
SELECT 'bd000002-0000-4000-8000-000000000002', c.id,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 6 THEN 'replied'
            WHEN row_number() OVER (ORDER BY c.created_at) <= 21 THEN 'read'
            WHEN row_number() OVER (ORDER BY c.created_at) <= 33 THEN 'delivered'
            ELSE 'failed' END,
       now()-interval '5 days',
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 33 THEN now()-interval '5 days'+interval '3 seconds' ELSE NULL END,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 21 THEN now()-interval '5 days'+interval '35 minutes' ELSE NULL END,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) <= 6 THEN now()-interval '5 days'+interval '1 hour' ELSE NULL END,
       CASE WHEN row_number() OVER (ORDER BY c.created_at) > 33 THEN 'Message undeliverable (131026)' ELSE NULL END
FROM contacts c WHERE c.account_id=:ACC AND c.phone IS NOT NULL
LIMIT 34;

-- ========================================================== PRODUCTS
INSERT INTO whatsapp_products (account_id, retailer_id, name, description, price, currency, is_active) VALUES
 (:ACC,'NSI-KIT-01','L-shaped modular kitchen','Acrylic finish, soft-close hardware, quartz counter. Price per running foot.', 165000,'INR',true),
 (:ACC,'NSI-KIT-02','Island kitchen','Full island with breakfast counter and integrated appliances.', 320000,'INR',true),
 (:ACC,'NSI-WRD-01','3-door sliding wardrobe','Mirror front, internal drawers and shoe rack.', 84000,'INR',true),
 (:ACC,'NSI-WRD-02','Walk-in wardrobe','Open modular system with island drawer unit.', 195000,'INR',true),
 (:ACC,'NSI-TV-01','Floating TV unit','Wall-mounted with concealed cable management.', 42000,'INR',true),
 (:ACC,'NSI-STD-01','Study + bookshelf','Compact home-office unit with pinboard.', 38000,'INR',true),
 (:ACC,'NSI-POO-01','Pooja unit','Teak finish with brass inlay and drawer.', 56000,'INR',true),
 (:ACC,'NSI-CRK-01','Crockery unit','Glass shutters with internal lighting.', 47000,'INR',false);

-- ===================================================== CHANNELS + DEV
INSERT INTO web_config (account_id, user_id, widget_key, widget_secret, allowed_origins,
                        status, installed_at, last_seen_at, ai_enabled, show_branding, locale, appearance)
VALUES (:ACC,:OWN,'wgt_demo_northside','DEMO_WIDGET_SECRET_NOT_A_CREDENTIAL',
        ARRAY['https://northsideinteriors.example','https://www.northsideinteriors.example'],
        'connected', now()-interval '80 days', now()-interval '2 hours', true, false, 'en',
        '{"accent":"#0f766e","position":"right","greeting":"Hi! Planning your interiors? Ask us anything."}'::jsonb);

INSERT INTO instagram_config (account_id, user_id, ig_user_id, ig_username, access_token,
                              status, subscribed_fields, subscribed_at, connected_at, comment_funnels_enabled)
VALUES (:ACC,:OWN,'17841400000000001','northside.interiors','DEMO_FAKE_IG_TOKEN_NOT_A_CREDENTIAL',
        'connected', ARRAY['messages','comments'], now()-interval '70 days', now()-interval '70 days', true);

INSERT INTO api_keys (account_id, created_by, name, key_prefix, key_hash, scopes, last_used_at) VALUES
 (:ACC,:OWN,'Website integration','wax_live_a1b2','DEMO_NOT_A_REAL_HASH_0001',
  ARRAY['contacts:read','contacts:write','messages:write'], now()-interval '3 hours'),
 (:ACC,:OWN,'Zapier','wax_live_c3d4','DEMO_NOT_A_REAL_HASH_0002',
  ARRAY['contacts:read','contacts:write','conversations:read'], now()-interval '2 days');

INSERT INTO webhook_endpoints (account_id, created_by, url, secret, events, is_active, last_delivery_at) VALUES
 (:ACC,:OWN,'https://hooks.northsideinteriors.example/watx','DEMO_WEBHOOK_SECRET_NOT_A_CREDENTIAL',
  ARRAY['message.received','conversation.created','form.submitted'], true, now()-interval '25 minutes');

-- ================================================= TEAM (pending invites)
INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, label, expires_at) VALUES
 (:ACC,'demo-invite-hash-0001','agent',:OWN,'arjun@northsideinteriors.example', now()+interval '5 days'),
 (:ACC,'demo-invite-hash-0002','agent',:OWN,'divya@northsideinteriors.example', now()+interval '6 days'),
 (:ACC,'demo-invite-hash-0003','admin',:OWN,'studio@northsideinteriors.example', now()+interval '6 days');

-- ============================================================== USAGE
INSERT INTO account_usage_monthly (account_id, period_start, messages_sent, broadcasts_sent) VALUES
 (:ACC, date_trunc('month', now())::date, 486, 2),
 (:ACC, (date_trunc('month', now())-interval '1 month')::date, 1240, 4),
 (:ACC, (date_trunc('month', now())-interval '2 months')::date, 980, 3)
ON CONFLICT (account_id, period_start) DO UPDATE SET messages_sent=EXCLUDED.messages_sent;

-- ====================================================== NOTIFICATIONS
INSERT INTO notifications (account_id, user_id, type, conversation_id, contact_id, title, body, read_at, created_at) VALUES
 (:ACC,:OWN,'conversation_assigned','bb000001-0000-4000-8000-000000000001','aaaa0001-0000-4000-8000-000000000001',
  'Ananya Iyer replied','Perfect. Send the revised quote and I will confirm by Friday.', NULL, now()-interval '3 hours'),
 (:ACC,:OWN,'automation',NULL,'aaaa0036-0000-4000-8000-000000000036',
  'Site visit booked','Neha Bansal — Thursday 4:00pm', NULL, now()-interval '40 minutes'),
 (:ACC,:OWN,'conversation_assigned','bb000006-0000-4000-8000-000000000006','aaaa0040-0000-4000-8000-000000000040',
  'New enquiry','Tara Dsouza started a conversation on WhatsApp', NULL, now()-interval '25 minutes'),
 (:ACC,:OWN,'automation',NULL,NULL,
  'Broadcast finished','Festive catalogue — 33 of 34 delivered', now()-interval '4 days', now()-interval '5 days');

COMMIT;

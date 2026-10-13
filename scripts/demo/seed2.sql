-- Northside Interiors DEMO — part 2: pipeline, deals, AI agents, inbox
\set ACC '''39795c53-4a45-43a2-acec-5cff48a889e1'''
\set OWN '''8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3'''
\set SIVA '''396afb78-ef6b-442a-84d5-5074afd23efe'''
\set PROF '''7851cd99-5a86-4328-b627-fe144b4ca74f'''

BEGIN;

-- ------------------------------------------------------------ pipeline
INSERT INTO pipelines (id, user_id, account_id, name) VALUES
 ('b1000001-0000-4000-8000-000000000001', :OWN, :ACC, 'Sales Pipeline'),
 ('b1000002-0000-4000-8000-000000000002', :OWN, :ACC, 'Trade & Architects');

INSERT INTO pipeline_stages (id, pipeline_id, name, position, color) VALUES
 ('b2000001-0000-4000-8000-000000000001','b1000001-0000-4000-8000-000000000001','New Lead',      0,'#3b82f6'),
 ('b2000002-0000-4000-8000-000000000002','b1000001-0000-4000-8000-000000000001','Qualified',     1,'#eab308'),
 ('b2000003-0000-4000-8000-000000000003','b1000001-0000-4000-8000-000000000001','Quote Sent',    2,'#f97316'),
 ('b2000004-0000-4000-8000-000000000004','b1000001-0000-4000-8000-000000000001','Negotiation',   3,'#8b5cf6'),
 ('b2000005-0000-4000-8000-000000000005','b1000001-0000-4000-8000-000000000001','Won',           4,'#10b981'),
 ('b2000011-0000-4000-8000-000000000011','b1000002-0000-4000-8000-000000000002','Enquiry',       0,'#3b82f6'),
 ('b2000012-0000-4000-8000-000000000012','b1000002-0000-4000-8000-000000000002','Site measured', 1,'#eab308'),
 ('b2000013-0000-4000-8000-000000000013','b1000002-0000-4000-8000-000000000002','Won',           2,'#10b981');

-- --------------------------------------------------------------- deals
INSERT INTO deals (id, user_id, account_id, pipeline_id, stage_id, contact_id, title,
                   value, currency, status, expected_close_date, assigned_to, notes, created_at) VALUES
 -- New Lead
 ('cc000001-0000-4000-8000-000000000001',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000001-0000-4000-8000-000000000001','aaaa0036-0000-4000-8000-000000000036','3BHK full home — Neha Bansal',           1450000,'INR','open',(now()+interval '38 days')::date,:PROF,'Possession in Jan. Wants a full package.',now()-interval '4 days'),
 ('cc000002-0000-4000-8000-000000000002',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000001-0000-4000-8000-000000000001','aaaa0038-0000-4000-8000-000000000038','Modular kitchen — Ishita Sen',            385000,'INR','open',(now()+interval '30 days')::date,:PROF,'Came in from the Instagram reel.',now()-interval '2 days'),
 ('cc000003-0000-4000-8000-000000000003',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000001-0000-4000-8000-000000000001','aaaa0040-0000-4000-8000-000000000040','Wardrobe + study — Tara Dsouza',           240000,'INR','open',(now()+interval '45 days')::date,:PROF,NULL,now()-interval '4 hours'),
 -- Qualified
 ('cc000004-0000-4000-8000-000000000004',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000002-0000-4000-8000-000000000002','aaaa0031-0000-4000-8000-000000000031','2BHK renovation — Rahul Verma',            720000,'INR','open',(now()+interval '25 days')::date,:PROF,'Budget confirmed. Waiting on the floor plan.',now()-interval '9 days'),
 ('cc000005-0000-4000-8000-000000000005',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000002-0000-4000-8000-000000000002','aaaa0028-0000-4000-8000-000000000028','Kitchen + utility — Pooja Mehta',           465000,'INR','open',(now()+interval '20 days')::date,:PROF,NULL,now()-interval '13 days'),
 ('cc000006-0000-4000-8000-000000000006',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000002-0000-4000-8000-000000000002','aaaa0023-0000-4000-8000-000000000023','Full home — Kavya Balan',                 1180000,'INR','open',(now()+interval '28 days')::date,:PROF,'Comparing three vendors. Lead with warranty.',now()-interval '18 days'),
 ('cc000007-0000-4000-8000-000000000007',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000002-0000-4000-8000-000000000002','aaaa0034-0000-4000-8000-000000000034','Living room makeover — Sara Thomas',        295000,'INR','open',(now()+interval '22 days')::date,:PROF,NULL,now()-interval '6 days'),
 -- Quote Sent
 ('cc000008-0000-4000-8000-000000000008',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000003-0000-4000-8000-000000000003','aaaa0017-0000-4000-8000-000000000017','Modular kitchen — Shruti Pillai',           520000,'INR','open',(now()+interval '15 days')::date,:PROF,'Quote sent 18th. Follow up Friday.',now()-interval '26 days'),
 ('cc000009-0000-4000-8000-000000000009',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000003-0000-4000-8000-000000000003','aaaa0013-0000-4000-8000-000000000013','Full home 3BHK — Nandita Roy',             1620000,'INR','open',(now()+interval '18 days')::date,:PROF,NULL,now()-interval '34 days'),
 ('cc000010-0000-4000-8000-000000000010',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000003-0000-4000-8000-000000000003','aaaa0021-0000-4000-8000-000000000021','Bedroom refit — Deepa Krishnan',            310000,'INR','open',(now()+interval '12 days')::date,:PROF,'Repeat customer — 10% loyalty applied.',now()-interval '20 days'),
 -- Negotiation
 ('cc000011-0000-4000-8000-000000000011',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000004-0000-4000-8000-000000000004','aaaa0001-0000-4000-8000-000000000001','4BHK full home — Ananya Iyer',             1850000,'INR','open',(now()+interval '9 days')::date,:PROF,'Walnut finish. Firm at 18L, pushing for 18.5.',now()-interval '61 days'),
 ('cc000012-0000-4000-8000-000000000012',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000004-0000-4000-8000-000000000004','aaaa0011-0000-4000-8000-000000000011','Modular kitchen — Lakshmi Venkatesh',       590000,'INR','open',(now()+interval '7 days')::date,:PROF,'Wants the German hardware upgrade.',now()-interval '38 days'),
 -- Won
 ('cc000013-0000-4000-8000-000000000013',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000005-0000-4000-8000-000000000005','aaaa0003-0000-4000-8000-000000000003','Whitefield 3BHK — Priya Raghunathan',      1340000,'INR','won',(now()-interval '12 days')::date,:PROF,'Second project with us.',now()-interval '55 days'),
 ('cc000014-0000-4000-8000-000000000014',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000005-0000-4000-8000-000000000005','aaaa0006-0000-4000-8000-000000000006','Office fit-out — Deshpande Associates',     980000,'INR','won',(now()-interval '20 days')::date,:PROF,NULL,now()-interval '48 days'),
 ('cc000015-0000-4000-8000-000000000015',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000005-0000-4000-8000-000000000005','aaaa0015-0000-4000-8000-000000000015','Wardrobe set — Aisha Rahman',               275000,'INR','won',(now()-interval '6 days')::date,:PROF,NULL,now()-interval '30 days'),
 ('cc000016-0000-4000-8000-000000000016',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000005-0000-4000-8000-000000000005','aaaa0026-0000-4000-8000-000000000026','Kitchen + wardrobes — Suresh Pillai',       745000,'INR','won',(now()-interval '2 days')::date,:PROF,'Referred by Vikram Chandra.',now()-interval '15 days'),
 -- Lost (honest pipelines leak)
 ('cc000017-0000-4000-8000-000000000017',:OWN,:ACC,'b1000001-0000-4000-8000-000000000001','b2000004-0000-4000-8000-000000000004','aaaa0010-0000-4000-8000-000000000010','Full home — Sanjay Bhatt',                  890000,'INR','lost',(now()-interval '10 days')::date,:PROF,'Went with a cheaper local vendor.',now()-interval '40 days'),
 -- Trade pipeline
 ('cc000018-0000-4000-8000-000000000018',:OWN,:ACC,'b1000002-0000-4000-8000-000000000002','b2000012-0000-4000-8000-000000000012','aaaa0008-0000-4000-8000-000000000008','Chandra Architects — 2 flats',             2350000,'INR','open',(now()+interval '40 days')::date,:PROF,'Trade pricing.',now()-interval '44 days'),
 ('cc000019-0000-4000-8000-000000000019',:OWN,:ACC,'b1000002-0000-4000-8000-000000000002','b2000011-0000-4000-8000-000000000011','aaaa0018-0000-4000-8000-000000000018','Reddy Builders — 6 units',                 4100000,'INR','open',(now()+interval '60 days')::date,:PROF,'Bulk. Needs a volume quote.',now()-interval '25 days'),
 ('cc000020-0000-4000-8000-000000000020',:OWN,:ACC,'b1000002-0000-4000-8000-000000000002','b2000013-0000-4000-8000-000000000013','aaaa0014-0000-4000-8000-000000000014','Shankar Interiors — wardrobe supply',       620000,'INR','won',(now()-interval '16 days')::date,:PROF,NULL,now()-interval '32 days');

-- ----------------------------------------------------------- AI agents
INSERT INTO ai_agents (id, account_id, created_by, name, channels, priority, is_active, model,
  agent_name, greeting_message, business_description, ground_rules, store_currency,
  tone, response_length, fallback_message, handoff_enabled, handoff_trigger_phrases,
  handoff_message, auto_reply_enabled, auto_reply_max_per_conversation,
  test_mode, skills, uses_all_knowledge, uses_all_actions) VALUES
 ('a9000001-0000-4000-8000-000000000001', :ACC, :OWN, 'Front desk',
  ARRAY['whatsapp','instagram','web'], 0, true, NULL,
  'Anu', 'Hi! Thanks for reaching out to Northside Interiors 👋 What are you planning — a full home, a kitchen, or something smaller?',
  'Northside Interiors is a Bengaluru interior design studio. We do full-home interiors, modular kitchens, wardrobes and office fit-outs. Projects run 6-10 weeks. We offer a 5-year warranty on all modular work.',
  'Never quote an exact final price — always give the starting range and offer a site visit. Never promise delivery under 6 weeks. Do not offer discounts; escalate any discount request to a human.',
  'INR', 'friendly', 'short',
  'Let me get one of our designers to answer that properly — one moment.',
  true, ARRAY['talk to human','speak to someone','call me','manager','complaint'],
  'Sure — passing you to one of our designers now. They will pick this up shortly.',
  true, 6, false,
  '{"appointments":{"enabled":true,"config":{}},"lookup_orders":{"enabled":true,"config":{}}}'::jsonb,
  true, true),
 ('a9000002-0000-4000-8000-000000000002', :ACC, :OWN, 'Kitchen specialist',
  ARRAY['whatsapp'], 1, true, NULL,
  'Ravi', 'Happy to help with the kitchen! Do you have the layout drawing handy?',
  'Specialist agent for modular kitchen enquiries at Northside Interiors.',
  'Always ask for carpet area and layout type (L-shape, U-shape, parallel, island) before giving a range. Never quote below ₹1,650 per sqft.',
  'INR', 'professional', 'medium',
  'I will check that with the design team and come back to you.',
  true, ARRAY['talk to human','site visit'],
  'Let me hand you to our kitchen designer.',
  true, 8, false,
  '{"appointments":{"enabled":true,"config":{}}}'::jsonb,
  true, false),
 ('a9000003-0000-4000-8000-000000000003', :ACC, :OWN, 'After-hours',
  ARRAY[]::text[], 2, true, NULL,
  'Northside', 'Thanks for messaging! Our studio is closed right now, but I can help with the basics and book you in for tomorrow.',
  'Out-of-hours responder for Northside Interiors.',
  'Never commit to a specific designer or a specific time without checking the calendar.',
  'INR', 'concise', 'short',
  'Our team will reply first thing tomorrow morning.',
  true, ARRAY['urgent','emergency'],
  'Flagging this for the team to pick up as soon as they are in.',
  true, 3, false, '{}'::jsonb, false, false);

COMMIT;

SELECT 'pipelines' t, count(*) FROM pipelines WHERE account_id=:ACC
UNION ALL SELECT 'stages', count(*) FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.account_id=:ACC
UNION ALL SELECT 'deals', count(*) FROM deals WHERE account_id=:ACC
UNION ALL SELECT 'deals won', count(*) FROM deals WHERE account_id=:ACC AND status='won'
UNION ALL SELECT 'ai_agents', count(*) FROM ai_agents WHERE account_id=:ACC;

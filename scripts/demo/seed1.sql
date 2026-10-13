-- Northside Interiors DEMO — part 1: foundation, tenancy, contacts
-- account 39795c53-4a45-43a2-acec-5cff48a889e1  owner 8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3
\set ACC '''39795c53-4a45-43a2-acec-5cff48a889e1'''
\set OWN '''8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3'''
\set SIVA '''396afb78-ef6b-442a-84d5-5074afd23efe'''
\set GROWTH '''7a4784ef-7520-40d4-8ee5-7d2a85532701'''

BEGIN;

-- currency/country for an India-based studio
UPDATE accounts SET default_currency='INR', default_country='IN' WHERE id=:ACC;

-- give the real operator admin access to the demo workspace
INSERT INTO account_members (account_id, user_id, role, invited_by)
VALUES (:ACC, :SIVA, 'admin', :OWN)
ON CONFLICT (account_id, user_id) DO UPDATE SET role='admin';

-- entitled, paid, not on trial: no trial banner in screenshots
INSERT INTO user_subscriptions
  (user_id, plan_id, status, billing_cycle, trial_start_at, trial_end_at,
   current_period_start, current_period_end, payment_method)
VALUES
  (:OWN, :GROWTH, 'active', 'monthly',
   now()-interval '95 days', now()-interval '80 days',
   now()-interval '11 days', now()+interval '19 days', 'razorpay')
ON CONFLICT (user_id) DO UPDATE
  SET plan_id=EXCLUDED.plan_id, status='active',
      current_period_start=EXCLUDED.current_period_start,
      current_period_end=EXCLUDED.current_period_end;

-- onboarding done, or the gate bounces every page to /welcome
INSERT INTO account_onboarding
  (account_id, goals, team_size, referral_source, completed_at, trial_granted_at)
VALUES
  (:ACC, ARRAY['sell_more','support_faster','automate'], '6-20', 'google',
   now()-interval '95 days', now()-interval '95 days')
ON CONFLICT (account_id) DO UPDATE
  SET completed_at=EXCLUDED.completed_at, trial_granted_at=EXCLUDED.trial_granted_at;

-- AI: platform credits
INSERT INTO ai_configs (account_id, created_by, provider, model, credit_mode,
                        embeddings_provider, embeddings_model)
VALUES (:ACC, :OWN, 'gemini', 'gemini-3.5-flash-lite', 'platform', 'gemini', 'text-embedding-004')
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO ai_credit_wallets (account_id, balance, signup_granted_at,
                               lifetime_purchased, lifetime_consumed)
VALUES (:ACC, 1840, now()-interval '95 days', 2500, 910)
ON CONFLICT (account_id) DO UPDATE SET balance=EXCLUDED.balance;

-- WhatsApp shown as connected & healthy. Credentials are deliberately fake.
INSERT INTO whatsapp_config
  (user_id, account_id, phone_number_id, waba_id, access_token, verify_token,
   status, connected_at, registered_at, subscribed_apps_at, connection_method,
   business_id, messaging_limit_tier, quality_rating, tier_daily_limit, limits_synced_at)
VALUES
  (:OWN, :ACC, '000000000000000', '000000000000000',
   'DEMO_FAKE_TOKEN_NOT_A_CREDENTIAL', 'demo-verify-token',
   'connected', now()-interval '92 days', now()-interval '92 days',
   now()-interval '92 days', 'embedded_signup', '000000000000000',
   'TIER_10K', 'GREEN', 10000, now()-interval '2 hours')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- tags
INSERT INTO tags (id, user_id, account_id, name, color) VALUES
 ('fa000001-0000-4000-8000-000000000001', :OWN, :ACC, 'Hot lead',        '#ef4444'),
 ('fa000002-0000-4000-8000-000000000002', :OWN, :ACC, 'VIP',             '#f59e0b'),
 ('fa000003-0000-4000-8000-000000000003', :OWN, :ACC, 'Site visit done', '#10b981'),
 ('fa000004-0000-4000-8000-000000000004', :OWN, :ACC, 'Repeat customer', '#8b5cf6'),
 ('fa000005-0000-4000-8000-000000000005', :OWN, :ACC, 'Architect',       '#0ea5e9'),
 ('fa000006-0000-4000-8000-000000000006', :OWN, :ACC, 'Bulk enquiry',    '#ec4899'),
 ('fa000007-0000-4000-8000-000000000007', :OWN, :ACC, 'Follow up',       '#f97316'),
 ('fa000008-0000-4000-8000-000000000008', :OWN, :ACC, 'Modular kitchen', '#14b8a6');

-- ------------------------------------------------------- custom fields
INSERT INTO custom_fields (user_id, account_id, field_name, field_type, field_options) VALUES
 (:OWN, :ACC, 'Budget range', 'select',
   '["Under 2L","2L - 5L","5L - 10L","10L - 25L","25L+"]'::jsonb),
 (:OWN, :ACC, 'Project type', 'select',
   '["Full home","Modular kitchen","Wardrobe","Office","Renovation"]'::jsonb),
 (:OWN, :ACC, 'Locality', 'text', NULL),
 (:OWN, :ACC, 'Possession date', 'date', NULL),
 (:OWN, :ACC, 'Carpet area (sqft)', 'number', NULL);

-- ------------------------------------------------------------ contacts
INSERT INTO contacts (id, user_id, account_id, name, phone, email, company,
                      source, ig_scoped_id, ig_username, web_visitor_id, created_at) VALUES
 ('aaaa0001-0000-4000-8000-000000000001',:OWN,:ACC,'Ananya Iyer','+919876500101','ananya.iyer@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '61 days'),
 ('aaaa0002-0000-4000-8000-000000000002',:OWN,:ACC,'Rohit Malhotra','+919876500102','rohit.m@outlook.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '58 days'),
 ('aaaa0003-0000-4000-8000-000000000003',:OWN,:ACC,'Priya Raghunathan','+919876500103','priya.r@gmail.com','Fern & Co','whatsapp',NULL,NULL,NULL,now()-interval '55 days'),
 ('aaaa0004-0000-4000-8000-000000000004',:OWN,:ACC,'Karthik Subramanian','+919876500104',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '52 days'),
 ('aaaa0005-0000-4000-8000-000000000005',:OWN,:ACC,'Meera Nair','+919876500105','meera.nair@gmail.com',NULL,'instagram','17841400000000105','meera.builds',NULL,now()-interval '50 days'),
 ('aaaa0006-0000-4000-8000-000000000006',:OWN,:ACC,'Arjun Deshpande','+919876500106','arjun.d@zohomail.in','Deshpande Associates','whatsapp',NULL,NULL,NULL,now()-interval '48 days'),
 ('aaaa0007-0000-4000-8000-000000000007',:OWN,:ACC,'Sneha Kulkarni','+919876500107','sneha.k@gmail.com',NULL,'web',NULL,NULL,'web-visitor-7a1c','2026-06-30 10:12:00+00'),
 ('aaaa0008-0000-4000-8000-000000000008',:OWN,:ACC,'Vikram Chandra','+919876500108','vikram@chandraarch.in','Chandra Architects','whatsapp',NULL,NULL,NULL,now()-interval '44 days'),
 ('aaaa0009-0000-4000-8000-000000000009',:OWN,:ACC,'Divya Menon','+919876500109','divya.menon@gmail.com',NULL,'instagram','17841400000000109','divya.at.home',NULL,now()-interval '42 days'),
 ('aaaa0010-0000-4000-8000-000000000010',:OWN,:ACC,'Sanjay Bhatt','+919876500110',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '40 days'),
 ('aaaa0011-0000-4000-8000-000000000011',:OWN,:ACC,'Lakshmi Venkatesh','+919876500111','lakshmi.v@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '38 days'),
 ('aaaa0012-0000-4000-8000-000000000012',:OWN,:ACC,'Imran Sheikh','+919876500112','imran.sheikh@gmail.com',NULL,'web',NULL,NULL,'web-visitor-3f8d','2026-07-15 09:03:00+00'),
 ('aaaa0013-0000-4000-8000-000000000013',:OWN,:ACC,'Nandita Roy','+919876500113','nandita.roy@gmail.com',NULL,'instagram','17841400000000113','nandita.roy',NULL,now()-interval '34 days'),
 ('aaaa0014-0000-4000-8000-000000000014',:OWN,:ACC,'Ravi Shankar','+919876500114',NULL,'Shankar Interiors','whatsapp',NULL,NULL,NULL,now()-interval '32 days'),
 ('aaaa0015-0000-4000-8000-000000000015',:OWN,:ACC,'Aisha Rahman','+919876500115','aisha.r@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '30 days'),
 ('aaaa0016-0000-4000-8000-000000000016',:OWN,:ACC,'Gaurav Khanna','+919876500116','gaurav.khanna@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '28 days'),
 ('aaaa0017-0000-4000-8000-000000000017',:OWN,:ACC,'Shruti Pillai','+919876500117','shruti.pillai@gmail.com',NULL,'instagram','17841400000000117','shruti.pillai',NULL,now()-interval '26 days'),
 ('aaaa0018-0000-4000-8000-000000000018',:OWN,:ACC,'Manoj Reddy','+919876500118','manoj.reddy@gmail.com','Reddy Builders','whatsapp',NULL,NULL,NULL,now()-interval '25 days'),
 ('aaaa0019-0000-4000-8000-000000000019',:OWN,:ACC,'Tanvi Joshi','+919876500119','tanvi.joshi@gmail.com',NULL,'web',NULL,NULL,'web-visitor-9b2e','2026-07-29 14:22:00+00'),
 ('aaaa0020-0000-4000-8000-000000000020',:OWN,:ACC,'Farhan Qureshi','+919876500120',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '22 days'),
 ('aaaa0021-0000-4000-8000-000000000021',:OWN,:ACC,'Deepa Krishnan','+919876500121','deepa.k@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '20 days'),
 ('aaaa0022-0000-4000-8000-000000000022',:OWN,:ACC,'Aditya Rao','+919876500122','aditya.rao@gmail.com',NULL,'instagram','17841400000000122','aditya.rao',NULL,now()-interval '19 days'),
 ('aaaa0023-0000-4000-8000-000000000023',:OWN,:ACC,'Kavya Balan','+919876500123','kavya.balan@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '18 days'),
 ('aaaa0024-0000-4000-8000-000000000024',:OWN,:ACC,'Nikhil Saxena','+919876500124',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '17 days'),
 ('aaaa0025-0000-4000-8000-000000000025',:OWN,:ACC,'Ritu Agarwal','+919876500125','ritu.agarwal@gmail.com',NULL,'web',NULL,NULL,'web-visitor-5d4a','2026-08-06 11:40:00+00'),
 ('aaaa0026-0000-4000-8000-000000000026',:OWN,:ACC,'Suresh Pillai','+919876500126','suresh.p@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '15 days'),
 ('aaaa0027-0000-4000-8000-000000000027',:OWN,:ACC,'Emily Foster','+447700900127','emily.foster@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '14 days'),
 ('aaaa0028-0000-4000-8000-000000000028',:OWN,:ACC,'Pooja Mehta','+919876500128','pooja.mehta@gmail.com',NULL,'instagram','17841400000000128','pooja.mehta',NULL,now()-interval '13 days'),
 ('aaaa0029-0000-4000-8000-000000000029',:OWN,:ACC,'Harish Kumar','+919876500129',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '12 days'),
 ('aaaa0030-0000-4000-8000-000000000030',:OWN,:ACC,'Anita Desai','+919876500130','anita.desai@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '11 days'),
 ('aaaa0031-0000-4000-8000-000000000031',:OWN,:ACC,'Rahul Verma','+919876500131','rahul.verma@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '9 days'),
 ('aaaa0032-0000-4000-8000-000000000032',:OWN,:ACC,'Zara Ahmed','+971500000132','zara.ahmed@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '8 days'),
 ('aaaa0033-0000-4000-8000-000000000033',:OWN,:ACC,'Vishal Nambiar','+919876500133','vishal.n@gmail.com',NULL,'web',NULL,NULL,'web-visitor-1e7b','2026-08-14 16:05:00+00'),
 ('aaaa0034-0000-4000-8000-000000000034',:OWN,:ACC,'Sara Thomas','+919876500134','sara.thomas@gmail.com',NULL,'instagram','17841400000000134','sara.thomas',NULL,now()-interval '6 days'),
 ('aaaa0035-0000-4000-8000-000000000035',:OWN,:ACC,'Abhishek Ghosh','+919876500135',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '5 days'),
 ('aaaa0036-0000-4000-8000-000000000036',:OWN,:ACC,'Neha Bansal','+919876500136','neha.bansal@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '4 days'),
 ('aaaa0037-0000-4000-8000-000000000037',:OWN,:ACC,'Joseph Mathew','+919876500137','joseph.mathew@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '3 days'),
 ('aaaa0038-0000-4000-8000-000000000038',:OWN,:ACC,'Ishita Sen','+919876500138','ishita.sen@gmail.com',NULL,'instagram','17841400000000138','ishita.sen',NULL,now()-interval '2 days'),
 ('aaaa0039-0000-4000-8000-000000000039',:OWN,:ACC,'Prakash Iyengar','+919876500139',NULL,NULL,'whatsapp',NULL,NULL,NULL,now()-interval '1 day'),
 ('aaaa0040-0000-4000-8000-000000000040',:OWN,:ACC,'Tara Dsouza','+919876500140','tara.dsouza@gmail.com',NULL,'whatsapp',NULL,NULL,NULL,now()-interval '4 hours');

-- ------------------------------------------------------- contact tags
INSERT INTO contact_tags (contact_id, tag_id)
SELECT c.id, t.id FROM (VALUES
 ('aaaa0001-0000-4000-8000-000000000001','Hot lead'),('aaaa0001-0000-4000-8000-000000000001','Site visit done'),
 ('aaaa0002-0000-4000-8000-000000000002','Modular kitchen'),
 ('aaaa0003-0000-4000-8000-000000000003','VIP'),('aaaa0003-0000-4000-8000-000000000003','Repeat customer'),
 ('aaaa0005-0000-4000-8000-000000000005','Hot lead'),
 ('aaaa0006-0000-4000-8000-000000000006','Architect'),('aaaa0006-0000-4000-8000-000000000006','Bulk enquiry'),
 ('aaaa0008-0000-4000-8000-000000000008','Architect'),('aaaa0008-0000-4000-8000-000000000008','VIP'),
 ('aaaa0009-0000-4000-8000-000000000009','Follow up'),
 ('aaaa0011-0000-4000-8000-000000000011','Modular kitchen'),('aaaa0011-0000-4000-8000-000000000011','Site visit done'),
 ('aaaa0013-0000-4000-8000-000000000013','Hot lead'),
 ('aaaa0014-0000-4000-8000-000000000014','Architect'),
 ('aaaa0015-0000-4000-8000-000000000015','Follow up'),
 ('aaaa0017-0000-4000-8000-000000000017','Hot lead'),('aaaa0017-0000-4000-8000-000000000017','Modular kitchen'),
 ('aaaa0018-0000-4000-8000-000000000018','Bulk enquiry'),
 ('aaaa0021-0000-4000-8000-000000000021','Repeat customer'),
 ('aaaa0022-0000-4000-8000-000000000022','Follow up'),
 ('aaaa0023-0000-4000-8000-000000000023','Hot lead'),('aaaa0023-0000-4000-8000-000000000023','Site visit done'),
 ('aaaa0026-0000-4000-8000-000000000026','VIP'),
 ('aaaa0028-0000-4000-8000-000000000028','Modular kitchen'),
 ('aaaa0030-0000-4000-8000-000000000030','Repeat customer'),
 ('aaaa0031-0000-4000-8000-000000000031','Hot lead'),
 ('aaaa0034-0000-4000-8000-000000000034','Follow up'),
 ('aaaa0036-0000-4000-8000-000000000036','Hot lead'),
 ('aaaa0038-0000-4000-8000-000000000038','Modular kitchen'),
 ('aaaa0040-0000-4000-8000-000000000040','Hot lead')
) AS v(cid, tname)
JOIN contacts c ON c.id = v.cid::uuid
JOIN tags t ON t.name = v.tname AND t.account_id = :ACC;

-- --------------------------------------------------------- segments
INSERT INTO contact_segments (id, account_id, user_id, name, description, color, kind, filter) VALUES
 ('5e000001-0000-4000-8000-000000000001', :ACC, :OWN, 'Monsoon campaign 2026',
  'Everyone who enquired during the July push', '#0ea5e9', 'static', '{}'::jsonb),
 ('5e000002-0000-4000-8000-000000000002', :ACC, :OWN, 'Architects & partners',
  'Trade accounts on partner pricing', '#8b5cf6', 'static', '{}'::jsonb),
 ('5e000003-0000-4000-8000-000000000003', :ACC, :OWN, 'Hot leads — all channels',
  'Auto-updating: anyone tagged Hot lead', '#ef4444', 'dynamic',
  '{"match":"all","rules":[{"field":"tag","operator":"has","value":"Hot lead"}]}'::jsonb),
 ('5e000004-0000-4000-8000-000000000004', :ACC, :OWN, 'Modular kitchen interest',
  'Auto-updating: tagged Modular kitchen', '#14b8a6', 'dynamic',
  '{"match":"all","rules":[{"field":"tag","operator":"has","value":"Modular kitchen"}]}'::jsonb);

INSERT INTO contact_segment_members (segment_id, contact_id, source, added_by)
SELECT '5e000001-0000-4000-8000-000000000001', id, 'import', :OWN FROM contacts
WHERE account_id=:ACC AND created_at BETWEEN now()-interval '45 days' AND now()-interval '20 days';

INSERT INTO contact_segment_members (segment_id, contact_id, source, added_by)
SELECT '5e000002-0000-4000-8000-000000000002', c.id, 'manual', :OWN
FROM contacts c JOIN contact_tags ct ON ct.contact_id=c.id
JOIN tags t ON t.id=ct.tag_id AND t.name='Architect' AND t.account_id=:ACC
WHERE c.account_id=:ACC;

-- ------------------------------------------------------------- notes
INSERT INTO contact_notes (contact_id, user_id, account_id, note_text, created_at) VALUES
 ('aaaa0001-0000-4000-8000-000000000001', :OWN, :ACC, 'Site visit done 12th. Wants the walnut finish, not oak. Budget is firm at 18L.', now()-interval '9 days'),
 ('aaaa0003-0000-4000-8000-000000000003', :OWN, :ACC, 'Second project with us — did her Whitefield flat in 2024. Repeat discount applies.', now()-interval '30 days'),
 ('aaaa0008-0000-4000-8000-000000000008', :OWN, :ACC, 'Sends us 3-4 clients a quarter. Keep on partner pricing.', now()-interval '20 days'),
 ('aaaa0017-0000-4000-8000-000000000017', :OWN, :ACC, 'Found us through the Instagram reel. Possession in November, so no rush.', now()-interval '12 days'),
 ('aaaa0023-0000-4000-8000-000000000023', :OWN, :ACC, 'Comparing us against two others. Price sensitive — lead with the 5-year warranty.', now()-interval '6 days');

COMMIT;

SELECT 'contacts' t, count(*) FROM contacts WHERE account_id=:ACC
UNION ALL SELECT 'tags', count(*) FROM tags WHERE account_id=:ACC
UNION ALL SELECT 'contact_tags', count(*) FROM contact_tags ct JOIN contacts c ON c.id=ct.contact_id WHERE c.account_id=:ACC
UNION ALL SELECT 'segments', count(*) FROM contact_segments WHERE account_id=:ACC
UNION ALL SELECT 'segment_members', count(*) FROM contact_segment_members sm JOIN contact_segments s ON s.id=sm.segment_id WHERE s.account_id=:ACC
UNION ALL SELECT 'custom_fields', count(*) FROM custom_fields WHERE account_id=:ACC
UNION ALL SELECT 'notes', count(*) FROM contact_notes WHERE account_id=:ACC;

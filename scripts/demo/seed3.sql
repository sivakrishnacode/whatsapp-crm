-- Northside Interiors DEMO — part 3: conversations + messages
\set ACC '''39795c53-4a45-43a2-acec-5cff48a889e1'''
\set OWN '''8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3'''
\set PROF '''7851cd99-5a86-4328-b627-fe144b4ca74f'''
\set AG1 '''a9000001-0000-4000-8000-000000000001'''
\set AG2 '''a9000002-0000-4000-8000-000000000002'''

BEGIN;

INSERT INTO conversations (id, user_id, account_id, contact_id, channel, status,
  assigned_agent_id, last_message_text, last_message_at, last_inbound_at,
  unread_count, ai_agent_id, ai_handoff_at, ai_reply_count, created_at) VALUES
 ('bb000001-0000-4000-8000-000000000001',:OWN,:ACC,'aaaa0001-0000-4000-8000-000000000001','whatsapp','open',:PROF,
   'Perfect. Send the revised quote and I will confirm by Friday.', now()-interval '3 hours', now()-interval '3 hours', 1, NULL, NULL, 0, now()-interval '61 days'),
 ('bb000002-0000-4000-8000-000000000002',:OWN,:ACC,'aaaa0017-0000-4000-8000-000000000017','instagram','open',:PROF,
   'Sure — passing you to one of our designers now.', now()-interval '5 hours', now()-interval '5 hours', 0, :AG1, now()-interval '5 hours', 3, now()-interval '26 days'),
 ('bb000003-0000-4000-8000-000000000003',:OWN,:ACC,'aaaa0036-0000-4000-8000-000000000036','whatsapp','open',NULL,
   'Booked you for Thursday 4pm ✅ You will get a reminder the day before.', now()-interval '40 minutes', now()-interval '45 minutes', 0, :AG1, NULL, 4, now()-interval '4 days'),
 ('bb000004-0000-4000-8000-000000000004',:OWN,:ACC,'aaaa0012-0000-4000-8000-000000000012','web','open',NULL,
   'Yes, we deliver across Bengaluru and Mysuru. Installation is included.', now()-interval '2 hours', now()-interval '2 hours', 0, :AG1, NULL, 2, now()-interval '37 days'),
 ('bb000005-0000-4000-8000-000000000005',:OWN,:ACC,'aaaa0011-0000-4000-8000-000000000011','whatsapp','open',:PROF,
   'The German hardware upgrade adds about ₹48,000. Worth it for the soft-close.', now()-interval '1 day', now()-interval '1 day', 0, :AG2, now()-interval '1 day', 2, now()-interval '38 days'),
 ('bb000006-0000-4000-8000-000000000006',:OWN,:ACC,'aaaa0040-0000-4000-8000-000000000040','whatsapp','open',NULL,
   'Hi, saw your work on Instagram. Do you do study units too?', now()-interval '25 minutes', now()-interval '25 minutes', 2, NULL, NULL, 0, now()-interval '4 hours'),
 ('bb000007-0000-4000-8000-000000000007',:OWN,:ACC,'aaaa0038-0000-4000-8000-000000000038','instagram','open',NULL,
   'What is the starting price for a modular kitchen?', now()-interval '90 minutes', now()-interval '90 minutes', 1, NULL, NULL, 0, now()-interval '2 days'),
 ('bb000008-0000-4000-8000-000000000008',:OWN,:ACC,'aaaa0003-0000-4000-8000-000000000003','whatsapp','closed',:PROF,
   'Thank you so much! The kitchen looks stunning 😍', now()-interval '11 days', now()-interval '11 days', 0, NULL, NULL, 0, now()-interval '55 days'),
 ('bb000009-0000-4000-8000-000000000009',:OWN,:ACC,'aaaa0008-0000-4000-8000-000000000008','whatsapp','open',:PROF,
   'Sending the measurements for both flats tomorrow morning.', now()-interval '2 days', now()-interval '2 days', 0, NULL, NULL, 0, now()-interval '44 days'),
 ('bb000010-0000-4000-8000-000000000010',:OWN,:ACC,'aaaa0023-0000-4000-8000-000000000023','whatsapp','pending',:PROF,
   'Let me check with my husband and get back to you.', now()-interval '4 days', now()-interval '4 days', 0, NULL, NULL, 0, now()-interval '18 days'),
 ('bb000011-0000-4000-8000-000000000011',:OWN,:ACC,'aaaa0034-0000-4000-8000-000000000034','instagram','open',NULL,
   'We start at ₹1,650 per sqft for modular. Want me to book a free site visit?', now()-interval '6 hours', now()-interval '7 hours', 0, :AG1, NULL, 3, now()-interval '6 days'),
 ('bb000012-0000-4000-8000-000000000012','8b5d67ba-0e33-4b83-8b36-1f94e39ecdf3',:ACC,'aaaa0031-0000-4000-8000-000000000031','whatsapp','open',:PROF,
   'Floor plan received, thanks. Quote by Wednesday.', now()-interval '2 days', now()-interval '3 days', 0, NULL, NULL, 0, now()-interval '9 days'),
 ('bb000013-0000-4000-8000-000000000013',:OWN,:ACC,'aaaa0026-0000-4000-8000-000000000026','whatsapp','closed',:PROF,
   'Installation complete. Warranty card is in the drawer 🙂', now()-interval '2 days', now()-interval '3 days', 0, NULL, NULL, 0, now()-interval '15 days'),
 ('bb000014-0000-4000-8000-000000000014',:OWN,:ACC,'aaaa0025-0000-4000-8000-000000000025','web','open',NULL,
   'Our studio is in Indiranagar, open 10am to 7pm, Monday to Saturday.', now()-interval '9 hours', now()-interval '9 hours', 0, :AG1, NULL, 1, now()-interval '15 days'),
 ('bb000015-0000-4000-8000-000000000015',:OWN,:ACC,'aaaa0028-0000-4000-8000-000000000028','instagram','open',:PROF,
   'Great — I will put together the utility layout as well.', now()-interval '3 days', now()-interval '3 days', 0, NULL, NULL, 0, now()-interval '13 days'),
 ('bb000016-0000-4000-8000-000000000016',:OWN,:ACC,'aaaa0032-0000-4000-8000-000000000032','whatsapp','open',NULL,
   'Do you ship to Dubai?', now()-interval '11 hours', now()-interval '11 hours', 1, NULL, NULL, 0, now()-interval '8 days'),
 ('bb000017-0000-4000-8000-000000000017',:OWN,:ACC,'aaaa0021-0000-4000-8000-000000000021','whatsapp','open',:PROF,
   'Applied your repeat-customer discount — revised quote attached.', now()-interval '5 days', now()-interval '6 days', 0, NULL, NULL, 0, now()-interval '20 days'),
 ('bb000018-0000-4000-8000-000000000018',:OWN,:ACC,'aaaa0013-0000-4000-8000-000000000013','instagram','open',:PROF,
   'Following up on the quote — any questions?', now()-interval '7 days', now()-interval '9 days', 0, NULL, NULL, 0, now()-interval '34 days'),
 ('bb000019-0000-4000-8000-000000000019',:OWN,:ACC,'aaaa0018-0000-4000-8000-000000000018','whatsapp','open',:PROF,
   'For 6 units we can do 12% off the standard rate.', now()-interval '6 days', now()-interval '6 days', 0, NULL, NULL, 0, now()-interval '25 days'),
 ('bb000020-0000-4000-8000-000000000020',:OWN,:ACC,'aaaa0037-0000-4000-8000-000000000037','whatsapp','open',NULL,
   'Thanks! Our team will reply first thing tomorrow morning.', now()-interval '14 hours', now()-interval '14 hours', 0, 'a9000003-0000-4000-8000-000000000003', NULL, 1, now()-interval '3 days');

-- ------------------------------------------------------------- messages
INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text, status, ai_agent_id, created_at) VALUES
-- 1: Ananya, human-run negotiation
('bb000001-0000-4000-8000-000000000001','customer',NULL,'text','Hi, we met at the Indiranagar studio last week. Sending the floor plan for the 4BHK.','received',NULL,now()-interval '9 days'),
('bb000001-0000-4000-8000-000000000001','agent',:PROF,'text','Hi Ananya! Lovely to hear from you. Got the plan — give me a day to work up the numbers.','read',NULL,now()-interval '9 days'+interval '20 minutes'),
('bb000001-0000-4000-8000-000000000001','agent',:PROF,'text','Quote is ready: ₹18,50,000 for the full home in the walnut finish, 5-year warranty on all modular work. Timeline 9 weeks from advance.','read',NULL,now()-interval '7 days'),
('bb000001-0000-4000-8000-000000000001','customer',NULL,'text','That is a bit above what we budgeted. We were hoping to land at 18.','received',NULL,now()-interval '5 days'),
('bb000001-0000-4000-8000-000000000001','agent',:PROF,'text','I can get you to ₹18,20,000 if we keep the laminate on the utility shutters. Everything else stays as specified.','read',NULL,now()-interval '4 days'),
('bb000001-0000-4000-8000-000000000001','customer',NULL,'text','Perfect. Send the revised quote and I will confirm by Friday.','received',NULL,now()-interval '3 hours'),
-- 2: Shruti, IG, AI then handoff
('bb000002-0000-4000-8000-000000000002','customer',NULL,'text','hi! saw the reel of the sage green kitchen 😍 how much would something like that cost','received',NULL,now()-interval '6 hours'),
('bb000002-0000-4000-8000-000000000002','bot',NULL,'text','Hi! Thanks for reaching out to Northside Interiors 👋 That one is a U-shaped modular in sage. Our modular kitchens start at ₹1,650 per sqft — for a layout like that it usually lands between ₹4.5L and ₹6L depending on hardware.','sent',:AG1,now()-interval '6 hours'+interval '8 seconds'),
('bb000002-0000-4000-8000-000000000002','customer',NULL,'text','ok that works. is the warranty on the whole thing or just the shutters?','received',NULL,now()-interval '5 hours'-interval '40 minutes'),
('bb000002-0000-4000-8000-000000000002','bot',NULL,'text','The 5-year warranty covers all modular work — carcass, shutters and hardware. Would you like to book a free site visit so we can measure up?','sent',:AG1,now()-interval '5 hours'-interval '39 minutes'),
('bb000002-0000-4000-8000-000000000002','customer',NULL,'text','can i talk to someone about a custom island instead','received',NULL,now()-interval '5 hours'-interval '2 minutes'),
('bb000002-0000-4000-8000-000000000002','bot',NULL,'text','Sure — passing you to one of our designers now. They will pick this up shortly.','sent',:AG1,now()-interval '5 hours'),
-- 3: Neha, WA, AI books an appointment
('bb000003-0000-4000-8000-000000000003','customer',NULL,'text','Hello, we are moving into a 3BHK in Hebbal in January. Do you handle full home interiors?','received',NULL,now()-interval '3 hours'),
('bb000003-0000-4000-8000-000000000003','bot',NULL,'text','Hi! Yes, full-home interiors are our main service 👋 For a 3BHK we would typically be looking at ₹12L to ₹18L depending on scope and finishes. What is your carpet area?','sent',:AG1,now()-interval '3 hours'+interval '6 seconds'),
('bb000003-0000-4000-8000-000000000003','customer',NULL,'text','1450 sqft. Can someone come and see the place?','received',NULL,now()-interval '2 hours'),
('bb000003-0000-4000-8000-000000000003','bot',NULL,'text','Absolutely. Site visits are free and take about 45 minutes. I have Thursday 4:00pm or Saturday 11:00am — which suits you?','sent',:AG1,now()-interval '2 hours'+interval '5 seconds'),
('bb000003-0000-4000-8000-000000000003','customer',NULL,'text','Thursday 4 works','received',NULL,now()-interval '45 minutes'),
('bb000003-0000-4000-8000-000000000003','bot',NULL,'text','Booked you for Thursday 4pm ✅ You will get a reminder the day before. Anything you would like the designer to bring along?','sent',:AG1,now()-interval '40 minutes'),
-- 4: Imran, web widget
('bb000004-0000-4000-8000-000000000004','customer',NULL,'text','Do you deliver outside Bengaluru?','received',NULL,now()-interval '2 hours'-interval '5 minutes'),
('bb000004-0000-4000-8000-000000000004','bot',NULL,'text','Yes, we deliver across Bengaluru and Mysuru. Installation is included.','sent',:AG1,now()-interval '2 hours'),
-- 5: Lakshmi, kitchen specialist
('bb000005-0000-4000-8000-000000000005','customer',NULL,'text','Sending the kitchen layout. It is a parallel kitchen, about 110 sqft.','received',NULL,now()-interval '2 days'),
('bb000005-0000-4000-8000-000000000005','bot',NULL,'text','Thanks! A parallel layout at 110 sqft works out to roughly ₹5,40,000 with our standard hardware. Would you like me to include the German soft-close option so you can compare?','sent',:AG2,now()-interval '2 days'+interval '12 seconds'),
('bb000005-0000-4000-8000-000000000005','customer',NULL,'text','Yes please, and what is the difference in practice?','received',NULL,now()-interval '1 day'-interval '3 hours'),
('bb000005-0000-4000-8000-000000000005','agent',:PROF,'text','The German hardware upgrade adds about ₹48,000. Worth it for the soft-close.','read',NULL,now()-interval '1 day'),
-- 6: Tara, brand new, unread
('bb000006-0000-4000-8000-000000000006','customer',NULL,'text','Hello','received',NULL,now()-interval '30 minutes'),
('bb000006-0000-4000-8000-000000000006','customer',NULL,'text','Hi, saw your work on Instagram. Do you do study units too?','received',NULL,now()-interval '25 minutes'),
-- 7: Ishita, IG, unread
('bb000007-0000-4000-8000-000000000007','customer',NULL,'text','What is the starting price for a modular kitchen?','received',NULL,now()-interval '90 minutes'),
-- 8: Priya, completed project
('bb000008-0000-4000-8000-000000000008','agent',:PROF,'text','Hi Priya! Installation is all wrapped up. The team has cleared out — let me know if anything needs adjusting.','read',NULL,now()-interval '12 days'),
('bb000008-0000-4000-8000-000000000008','customer',NULL,'text','Thank you so much! The kitchen looks stunning 😍','received',NULL,now()-interval '11 days'),
-- 9: Vikram, trade
('bb000009-0000-4000-8000-000000000009','agent',:PROF,'text','Hi Vikram, happy to quote both flats together — that gets you the trade rate on the whole lot.','read',NULL,now()-interval '3 days'),
('bb000009-0000-4000-8000-000000000009','customer',NULL,'text','Sending the measurements for both flats tomorrow morning.','received',NULL,now()-interval '2 days'),
-- 10: Kavya, pending
('bb000010-0000-4000-8000-000000000010','agent',:PROF,'text','Quote sent across — ₹11,80,000 all in, and that includes the 5-year warranty which the other two quotes you mentioned do not.','read',NULL,now()-interval '5 days'),
('bb000010-0000-4000-8000-000000000010','customer',NULL,'text','Let me check with my husband and get back to you.','received',NULL,now()-interval '4 days'),
-- 11: Sara, IG, AI
('bb000011-0000-4000-8000-000000000011','customer',NULL,'text','hi, do you do just the living room or is it full home only?','received',NULL,now()-interval '7 hours'),
('bb000011-0000-4000-8000-000000000011','bot',NULL,'text','We are happy to do single rooms 🙂 Living room makeovers typically run ₹2.5L to ₹4L depending on whether you want a TV unit and seating built in.','sent',:AG1,now()-interval '7 hours'+interval '7 seconds'),
('bb000011-0000-4000-8000-000000000011','customer',NULL,'text','TV unit yes, seating no','received',NULL,now()-interval '6 hours'-interval '20 minutes'),
('bb000011-0000-4000-8000-000000000011','bot',NULL,'text','We start at ₹1,650 per sqft for modular. Want me to book a free site visit?','sent',:AG1,now()-interval '6 hours'),
-- 12: Rahul
('bb000012-0000-4000-8000-000000000012','customer',NULL,'text','Attaching the floor plan for the 2BHK renovation.','received',NULL,now()-interval '3 days'),
('bb000012-0000-4000-8000-000000000012','agent',:PROF,'text','Floor plan received, thanks. Quote by Wednesday.','read',NULL,now()-interval '2 days'),
-- 13: Suresh, delivered
('bb000013-0000-4000-8000-000000000013','customer',NULL,'text','All done at our end. Really happy with how the wardrobes turned out.','received',NULL,now()-interval '3 days'),
('bb000013-0000-4000-8000-000000000013','agent',:PROF,'text','Installation complete. Warranty card is in the drawer 🙂','read',NULL,now()-interval '2 days'),
-- 14: Ritu, web, AI
('bb000014-0000-4000-8000-000000000014','customer',NULL,'text','Where is your showroom and what are the timings?','received',NULL,now()-interval '9 hours'-interval '2 minutes'),
('bb000014-0000-4000-8000-000000000014','bot',NULL,'text','Our studio is in Indiranagar, open 10am to 7pm, Monday to Saturday.','sent',:AG1,now()-interval '9 hours'),
-- 15: Pooja
('bb000015-0000-4000-8000-000000000015','customer',NULL,'text','Can you also do the utility area along with the kitchen?','received',NULL,now()-interval '3 days'-interval '1 hour'),
('bb000015-0000-4000-8000-000000000015','agent',:PROF,'text','Great — I will put together the utility layout as well.','read',NULL,now()-interval '3 days'),
-- 16: Zara, unread, international
('bb000016-0000-4000-8000-000000000016','customer',NULL,'text','Do you ship to Dubai?','received',NULL,now()-interval '11 hours'),
-- 17: Deepa
('bb000017-0000-4000-8000-000000000017','customer',NULL,'text','Hi! Doing up the master bedroom this time. Same team if possible.','received',NULL,now()-interval '6 days'),
('bb000017-0000-4000-8000-000000000017','agent',:PROF,'text','Applied your repeat-customer discount — revised quote attached.','read',NULL,now()-interval '5 days'),
-- 18: Nandita
('bb000018-0000-4000-8000-000000000018','customer',NULL,'text','Got the quote, going through it with the family.','received',NULL,now()-interval '9 days'),
('bb000018-0000-4000-8000-000000000018','agent',:PROF,'text','Following up on the quote — any questions?','read',NULL,now()-interval '7 days'),
-- 19: Manoj, bulk
('bb000019-0000-4000-8000-000000000019','customer',NULL,'text','We have 6 units in the Sarjapur project. What is your best rate?','received',NULL,now()-interval '6 days'-interval '2 hours'),
('bb000019-0000-4000-8000-000000000019','agent',:PROF,'text','For 6 units we can do 12% off the standard rate.','read',NULL,now()-interval '6 days'),
-- 20: Joseph, after-hours agent
('bb000020-0000-4000-8000-000000000020','customer',NULL,'text','Hi, is anyone there? Need a quote urgently.','received',NULL,now()-interval '14 hours'-interval '1 minute'),
('bb000020-0000-4000-8000-000000000020','bot',NULL,'text','Thanks! Our team will reply first thing tomorrow morning.','sent','a9000003-0000-4000-8000-000000000003',now()-interval '14 hours');

COMMIT;

SELECT 'conversations' t, count(*) FROM conversations WHERE account_id=:ACC
UNION ALL SELECT '  whatsapp', count(*) FROM conversations WHERE account_id=:ACC AND channel='whatsapp'
UNION ALL SELECT '  instagram', count(*) FROM conversations WHERE account_id=:ACC AND channel='instagram'
UNION ALL SELECT '  web', count(*) FROM conversations WHERE account_id=:ACC AND channel='web'
UNION ALL SELECT 'messages', count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=:ACC
UNION ALL SELECT '  by bot', count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=:ACC AND m.sender_type='bot';

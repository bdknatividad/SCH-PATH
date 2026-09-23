-- SCH-PATH: Hash existing user passwords
-- Run this in phpMyAdmin: sch_path_db > SQL tab
-- Uses double quotes to avoid dollar sign parsing issues

UPDATE `users` SET `password` = "$2b$10$RWLlc4ZS3gaLkA5khg4iIujGauTDZz.UOgmRZPUzI9ztadHZAopdS" WHERE `id` = "U001";
UPDATE `users` SET `password` = "$2b$10$oRgvPWT/0jrQLPsluSJGQetseXaJB0frvVwm7dKmLZ/74CIaoMFA6" WHERE `id` = "U002";
UPDATE `users` SET `password` = "$2b$10$z18vCH2nIBKG..NIwHPA0e8rk1p0.egBOOcyzLg3Tw0m9eHQCrH8." WHERE `id` = "U003";
UPDATE `users` SET `password` = "$2b$10$LXmXAu7GDmy/eqeh/DokLu0VCB4.gnMeikRdfF5zxpBDjELmtG/5y" WHERE `id` = "U004";
UPDATE `users` SET `password` = "$2b$10$irib6M6x2ghXeRRldKaQpuoQcUNZPe9MZ1vMVqPiS0.32sIbKVWEC" WHERE `id` = "U005";
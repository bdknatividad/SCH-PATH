/**
 * Database Seeding Script
 * @description Creates default users if they don't exist
 */

const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { generateId } = require('../utils/helpers');

const DEFAULT_USERS = [
  { id: 'U001', username: 'centerhead', password: 'centerhead123', role: 'centerhead', status: 'Active' },
  // ── Seeded accounts inherit their role's matrix ───────────────────────────
  //
  // These entries used to carry a hand-written `accessibleModules` array, which
  // was a *second copy* of `config/rbac.definition.json`. It drifted, and
  // because `buildAccessSnapshot()` prefers a non-empty stored grant over the
  // role matrix, the stale copy won — in both directions:
  //
  //   socialworker  lost Activities and Assessments (both granted by the
  //                 definition) and still carried the pre-rename `TRI` key
  //   nurse         gained Reports and Activities, and lost Child Records
  //   educator      gained Activities, and lost Child Records
  //
  // The Nurse gaining Reports is the sharp one: the role's specification says
  // the Nurse must not reach Reports at all.
  //
  // Omitting the field writes `[]`, which every reader — `buildAccessSnapshot`,
  // `resolveModuleAccess` and Account Management — interprets as "use the
  // role's declared matrix". That makes the definition the single source of
  // truth, so a future matrix change cannot leave the seed behind again.
  //
  // The Social Worker still reaches the TRI/Houseparent workflow: the module
  // was renamed to `Houseparent`, the definition grants it to that role, and
  // `TRI` remains declared as one of its `legacyKeys`.
  { id: 'U002', username: 'socialworker', password: 'social123', role: 'socialworker', status: 'Active' },
  { id: 'U003', username: 'psychologist', password: 'psych123', role: 'psychologist', status: 'Active' },
  { id: 'U004', username: 'nurse', password: 'nurse123', role: 'nurse', status: 'Active' },
  { id: 'U005', username: 'educator', password: 'educator123', role: 'educator', status: 'Active' },
  // Ten starter Houseparent accounts, so a fresh database has a working
  // roster. They are seed convenience only — NOT a whitelist. Any additional
  // Houseparent created through Account Management is just as valid, and is
  // listed by GET /resident-assignments/caseload (which selects on the role
  // column) the moment the account is saved.
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `UHP${String(i + 1).padStart(2, '0')}`,
    username: `HP ${i + 1}`,
    password: `hp${i + 1}123`,
    role: 'houseparent',
    status: 'Active',
  })),
];

async function ensureViolationGuideTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS violation_guide (
      id VARCHAR(40) PRIMARY KEY,
      name VARCHAR(500) NOT NULL,
      category ENUM('Minor', 'Major') NOT NULL DEFAULT 'Minor',
      description TEXT NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      createdBy VARCHAR(100) NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updatedBy VARCHAR(100) NULL,
      INDEX idx_status (status),
      INDEX idx_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS intervention_types (
      id VARCHAR(40) PRIMARY KEY,
      type VARCHAR(100) NOT NULL UNIQUE,
      description TEXT NULL,
      requiresDuration BOOLEAN NOT NULL DEFAULT TRUE,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guide_interventions (
      id VARCHAR(40) PRIMARY KEY,
      guideId VARCHAR(40) NOT NULL,
      offenseLevel VARCHAR(50) NOT NULL,
      interventionType VARCHAR(100) NOT NULL,
      duration INT NULL,
      unit VARCHAR(50) NULL,
      metadata JSON NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
      INDEX idx_guideId (guideId),
      INDEX idx_offenseLevel (offenseLevel)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`ALTER TABLE guide_interventions MODIFY COLUMN offenseLevel VARCHAR(50) NOT NULL`);

  await pool.query("DELETE FROM intervention_types WHERE type = 'Guide Requirement'");

  await pool.query(`
    INSERT INTO intervention_types (id, type, description, requiresDuration)
    VALUES
            ('IT002', 'Psychosocial Activity', 'Psychosocial activity required by the official guide', FALSE),
      ('IT003', 'Privilege Restriction', 'Restriction of a specific privilege described by the guide', TRUE),
      ('IT004', 'Privilege Suspension', 'Suspension of privileges described by the guide', TRUE),
      ('IT005', 'Household Chores', 'Household chore requirement described by the guide', TRUE),
      ('IT006', 'Cleaning', 'Cleaning requirement described by the guide', TRUE),
      ('IT007', 'Confiscation', 'Confiscation / safekeeping requirement', FALSE),
      ('IT008', 'Other', 'Other exact requirement from the guide', FALSE),
('IT009', 'Isolation', 'Isolation requirement described by the guide', TRUE)
    ON DUPLICATE KEY UPDATE
      description = VALUES(description),
      requiresDuration = VALUES(requiresDuration)
  `);
}

const OFFICIAL_VIOLATION_GUIDE = [
  // =========================
  // MINOR OFFENSES
  // =========================
  {
    id: 'VG001',
    name: 'Pagsuway sa schedule at di pagsali sa mga activities tulad ng tutorials, exercise psychosocial activities at iba pang Gawain nasa programa ng shelter',
    category: 'Minor',
    description: 'Pagsuway sa schedule at di pagsali sa mga activities tulad ng tutorials, exercise psychosocial activities at iba pang Gawain nasa programa ng shelter',
    interventions: {
      '1st': [
        '2 days no watching tv (no involvement in music activity)',
        'psychosocial activity'
      ],
      '2nd': [
        '4 days no watching tv (no involvement in music activity)',
        '3 mins video call/phone call',
        'Psychosocial activity'
      ],
      '3rd': [
        '1 week privilege suspension',
        'Psychosocial activity'
      ],
    },
  },

  {
    id: 'VG002',
    name: 'Pagbubukas ng appliances at pagpasok sa mga kwarto tulad ng storage room at office ng walang pahintulot, pagpasok sa kabilang room (room 1 or 2) at pagpasok sa CR habang may tao pa sa loob.',
    category: 'Minor',
    description: 'Pagbubukas ng appliances at pagpasok sa mga kwarto tulad ng storage room at office ng walang pahintulot, pagpasok sa kabilang room (room 1 or 2) at pagpasok sa CR habang may tao pa sa loob.',
    interventions: {
      '1st': [
        '1 day CR cleaning (down)',
        'psychosocial activity (residents and staff CR)'
      ],
      '2nd': [
        '2 days CR cleaning (up and down)',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days CR cleaning (up and down)',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG003',
    name: 'Pagsusuot ng anumang uri ng alahas/palamuti sa katawan tulad ng relo, kwintas, angklet, singsing, sombrero at iba pa',
    category: 'Minor',
    description: 'Pagsusuot ng anumang uri ng alahas/palamuti sa katawan tulad ng relo, kwintas, angklet, singsing, sombrero at iba pa',
    interventions: {
      '1st': [
        'confiscate at ipapauwi sa magulang',
        'psychosocial activity'
      ],
      '2nd': [
        'confiscate and safe keeping',
        'psychosocial activity'
      ],
      '3rd': [
        'Confiscate and safe keeping',
        'laundry of bedsheets and towels',
        '1 month no visitation'
      ],
    },
  },

  {
    id: 'VG004',
    name: 'Paghingi ng pansariling interest sa kapwa residente / pakikipagpalit ng gamit',
    category: 'Minor',
    description: 'Paghingi ng pansariling interest sa kapwa residente / pakikipagpalit ng gamit',
    interventions: {
      '1st': [
        'Pagpapauwi ng mga gamit na pinalitan or in-arbor sa kapwa residente. At di na ito pwedeng dalhan ng magulang ng gamit.'
      ],
      '2nd': [
        'Pagpapauwi ng mga gamit na pinalitan or in-arbor sa kapwa residente. At di na ito pwedeng dalhan ng magulang ng gamit.'
      ],
      '3rd': [
        'Pagpapauwi ng mga gamit na pinalitan or in-arbor sa kapwa residente. At di na ito pwedeng dalhan ng magulang ng gamit.'
      ],
    },
  },

  {
    id: 'VG005',
    name: 'Pag-iingay sa oras ng Pag-aaral',
    category: 'Minor',
    description: 'Pag-iingay sa oras ng Pag-aaral',
    interventions: {
      '1st': [
        '1 day no using of tablet during study time',
        'psychosocial activity',
        '1 day household chores'
      ],
      '2nd': [
        '2 days no using of tablet during study time',
        'psychosocial activity',
        '2 days household chores'
      ],
      '3rd': [
        '3 days no using of tablet during study time',
        'psychosocial activity',
        '3 days household chores'
      ],
    },
  },

  {
    id: 'VG006',
    name: 'Pag-iingay sa oras ng Panonood ng tv',
    category: 'Minor',
    description: 'Pag-iingay sa oras ng Panonood ng tv',
    interventions: {
      '1st': [
        '1 day no watching tv (no involvement in music activity)',
        'psychosocial activity'
      ],
      '2nd': [
        '2 days no watching tv (no involvement in music activity)',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days no watching tv (no involvement in music activity)',
        'privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG007',
    name: 'Pag-iingay sa oras ng Pagtulog',
    category: 'Minor',
    description: 'Pag-iingay sa oras ng Pagtulog',
    interventions: {
      '1st': [
        '1 day no nap time',
        'psychosocial activity'
      ],
      '2nd': [
        '2 days no nap time',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days no nap time',
        'privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG008',
    name: 'Pagtago ng pagkain sa kwarto.',
    category: 'Minor',
    description: 'Pagtago ng pagkain sa kwarto.',
    interventions: {
      '1st': [
        'No merienda sa susunod na araw at huling kakain'
      ],
      '2nd': [
        '1 week no merienda',
        'privilege suspension'
      ],
      '3rd': [
        'privilege suspension during last Wednesday'
      ],
    },
  },

  {
    id: 'VG009',
    name: 'Late gumising, pagligo ng sabay at pagligo ng wala sa oras.',
    category: 'Minor',
    description: 'Late gumising, pagligo ng sabay at pagligo ng wala sa oras.',
    interventions: {
      '1st': [
        'Huling kakain',
        '1 day household chores'
      ],
      '2nd': [
        'Huling kakain',
        '1 day household chores'
      ],
      '3rd': [
        'Huling kakain',
        '1 day household chores'
      ],
    },
  },

  {
    id: 'VG010',
    name: 'Hindi pagkain sa takdang oras (not unless sick)',
    category: 'Minor',
    description: 'Hindi pagkain sa takdang oras (not unless sick)',
    interventions: {
      '1st': [
        'Ipapakain ang kanyang pagkain sa mga kapwa residente'
      ],
      '2nd': [
        'Ipapakain ang kanyang pagkain sa mga kapwa residente'
      ],
      '3rd': [
        'Ipapakain ang kanyang pagkain sa mga kapwa residente'
      ],
    },
  },

  {
    id: 'VG011',
    name: 'Kawalang respeto sa hapag Kainan.',
    category: 'Minor',
    description: 'Kawalang respeto sa hapag Kainan.',
    interventions: {
      '1st': [
        'half rice and half ulam on a current meal and on the following meals'
      ],
      '2nd': [
        'half rice and half ulam on the following meals, huling kakain',
        'cleaning of dining area'
      ],
      '3rd': [
        'half rice and half ulam on the following meals, huling kakain',
        '2 days household chores'
      ],
    },
  },

  {
    id: 'VG012',
    name: 'Vandalism',
    category: 'Minor',
    description: 'Vandalism',
    interventions: {
      '1st': [
        'Pagkuskos/pagbura ng mga sulat sa pader at pagbili ng 1 Litro ng puting pintura'
      ],
      '2nd': [
        'Pagkuskos/pagbura ng mga sulat sa pader at pagbili ng 1 Litro ng puting pintura'
      ],
      '3rd': [
        'Pagkuskos/pagbura ng mga sulat sa pader at pagbili ng 1 Litro ng puting pintura'
      ],
    },
  },

  {
    id: 'VG013',
    name: 'Paglalagi sa baba na hindi naman toka sa paglalaba o pagluluto at paglalagi sa viewing area na hindi naman oras ng panonood',
    category: 'Minor',
    description: 'Paglalagi sa baba na hindi naman toka sa paglalaba o pagluluto at paglalagi sa viewing area na hindi naman oras ng panonood',
    interventions: {
      '1st': [
        'verbal warning',
        'dialogue'
      ],
      '2nd': [
        '1 day cleaning of receiving area',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days cleaning of receiving area',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG014',
    name: 'Walang pantaas na damit, pag hubo at nakaboxer shorts (except nap time or bed time at washing dishes at laundry area)',
    category: 'Minor',
    description: 'Walang pantaas na damit, pag hubo at nakaboxer shorts (except nap time or bed time at washing dishes at laundry area)',
    interventions: {
      '1st': [
        'Verbal warning',
        'Dialogue'
      ],
      '2nd': [
        '1 day cleaning of laundry area',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days cleaning of laundry area',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG015',
    name: 'Hindi pag-ayos ng higaan o pagsalansan ng mga kutson, paglatag ng kutson at pagtulog kapag hindi oras ng nap time or bed time (not unless sick)',
    category: 'Minor',
    description: 'Hindi pag-ayos ng higaan o pagsalansan ng mga kutson, paglatag ng kutson at pagtulog kapag hindi oras ng nap time or bed time (not unless sick)',
    interventions: {
      '1st': [
        'pagsamsam ng unan'
      ],
      '2nd': [
        'pagsamsam ng kutson'
      ],
      '3rd': [
        'Pagsamsam ng unan at kutson'
      ],
    },
  },

  {
    id: 'VG016',
    name: 'Pagsabit ng kung anu-ano sa bintana ng bawat room',
    category: 'Minor',
    description: 'Pagsabit ng kung anu-ano sa bintana ng bawat room',
    interventions: {
      '1st': [
        'Pagsamsam at pagpapauwi ng kung anuman ang nadatnang gamit na nakasabit'
      ],
      '2nd': [
        'Pagsamsam at pagpapauwi ng kung anuman ang nadatnang gamit na nakasabit'
      ],
      '3rd': [
        'Pagsamsam at pagpapauwi ng kung anuman ang nadatnang gamit na nakasabit'
      ],
    },
  },

  {
    id: 'VG017',
    name: 'Pagsilip at Pakikipag usap sa kapwa residente na nasa loob ng isolation room',
    category: 'Minor',
    description: 'Pagsilip at Pakikipag usap sa kapwa residente na nasa loob ng isolation room',
    interventions: {
      '1st': [
        'no phone call / video call'
      ],
      '2nd': [
        'isasama sa isolation'
      ],
      '3rd': [
        'isasama sa isolation'
      ],
    },
  },

  {
    id: 'VG018',
    name: 'Pakikipag-usap sa labas ng isolation.',
    category: 'Minor',
    description: 'Pakikipag-usap sa labas ng isolation.',
    interventions: {
      '1st': [
        '+ 1 day in isolation room sa bawat batang kinakausap'
      ],
      '2nd': [
        '+ 1 day in isolation room sa bawat batang kinakausap'
      ],
      '3rd': [
        '+ 1 day in isolation room sa bawat batang kinakausap'
      ],
    },
  },

  // =========================
  // MAJOR OFFENSES
  // =========================

  {
    id: 'VG019',
    name: 'Pagtangkang tumakas at Pagtakas — Pagpaplano at pagyayakag sa Pagtakas (no resistance)',
    category: 'Major',
    description: 'Pagpaplano at pagyayakag sa Pagtakas (no resistance)',
    interventions: {
      '1st': [
        '1 meal HHC',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
      '2nd': [
        '1 meal HHC',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
      '3rd': [
        '1 meal HHC',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
    },
  },

  {
    id: 'VG020',
    name: 'Pagtangkang tumakas at Pagtakas — Pagpaplano at pagyayakag sa Pagtakas (with resistance)',
    category: 'Major',
    description: 'Pagpaplano at pagyayakag sa Pagtakas (with resistance)',
    interventions: {
      '1st': [
        '1 day household chores',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
      '2nd': [
        '1 day household chores',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
      '3rd': [
        '1 day household chores',
        'Privilege suspension',
        'psychosocial activity',
        '3 days isolation'
      ],
    },
  },

  {
    id: 'VG021',
    name: 'Pag gamit at pagpasok ng Pera at phone',
    category: 'Major',
    description: 'Pag gamit at pagpasok ng Pera at phone',
    interventions: {
      '1st': [
        '2 weeks Privilege Suspension',
        'psychosocial activity'
      ],
      '2nd': [
        '2 weeks Privilege Suspension',
        '2 days household chores',
        'psychosocial activity'
      ],
      '3rd': [
        '2 weeks Privilege',
        '2 days household chores and Laundry of bedsheets & towels',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG022',
    name: 'Pag gamit at pagpasok ng Alak at sigarilyo',
    category: 'Major',
    description: 'Pag gamit at pagpasok ng Alak at sigarilyo',
    interventions: {
      '1st': [
        '2 weeks Privilege Suspension',
        '1 day household chores',
        'psychosocial activity'
      ],
      '2nd': [
        '2 weeks Privilege Suspension',
        '3 days household chores',
        'psychosocial activity'
      ],
      '3rd': [
        '2 weeks Privilege Suspension',
        '3 days household chores and Laundry of bedsheets & towels',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG023',
    name: 'Pag gamit at pagpasok ng Droga sa shelter',
    category: 'Major',
    description: 'Pag gamit at pagpasok ng Droga sa shelter',
    interventions: {
      '1st': [
        'Drug test',
        'Blotter',
        'case filling'
      ],
      '2nd': [
        'Drug test',
        'Blotter',
        'case filling'
      ],
      '3rd': [
        'Drug test',
        'Blotter',
        'case filling'
      ],
    },
  },

  {
    id: 'VG024',
    name: 'Pag gamit ng tablet na hindi naaayon sa pagsagot ng modules/pagvisit sa mga sites na hindi kailangan sa pagsagot ng modules tulad ng incognito, pag log in sa social media accounts,',
    category: 'Major',
    description: 'Pag gamit ng tablet na hindi naaayon sa pagsagot ng modules/pagvisit sa mga sites na hindi kailangan sa pagsagot ng modules tulad ng incognito, pag log in sa social media accounts,',
    interventions: {
      '1st': [
        '2 weeks Privilege Suspension',
        '2 weeks no tablet use',
        'psychosocial activities'
      ],
      '2nd': [
        '3 weeks Privilege Suspension',
        '2 days household chores',
        '3 weeks no use of tablet',
        'psychosocial activities'
      ],
      '3rd': [
        '3weeks Privilege suspension',
        '3 days household chores',
        '1 month no use of tablet',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG025',
    name: 'Pakikipag-away, pananakit, at pakikipagsuntukan sa kapwa residente o staff; Halimbawa: sparring, pengkoy, pitikan, sapukan, pang-uulok na nagresulta sa away at iba pa',
    category: 'Major',
    description: 'Pakikipag-away, pananakit, at pakikipagsuntukan sa kapwa residente o staff; Halimbawa: sparring, pengkoy, pitikan, sapukan, pang-uulok na nagresulta sa away at iba pa',
    interventions: {
      '1st': [
        '1day household chores',
        'Laundry of bedsheets and towels',
        '1-week privilege suspension',
        'psychosocial activity'
      ],
      '2nd': [
        '1 day isolation',
        '2 days household chores',
        '1 week privilege suspension',
        'psychosocial activity'
      ],
      '3rd': [
        '2 days isolation',
        '2weeks Privilege Suspension',
        '3 days household chores',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG026',
    name: 'Pagsira ng anumang uri ng gamit sa shelter',
    category: 'Major',
    description: 'Pagsira ng anumang uri ng gamit sa shelter',
    interventions: {
      '1st': [
        'Pagpalit/Pagbayad ng nasirang gamit & character building',
        'counseling'
      ],
      '2nd': [
        'Pagpalit/Pagbayad ng nasirang gamit & character building',
        'Counseling',
        'privilege suspension'
      ],
      '3rd': [
        'Pagpalit/Pagbayad ng nasirang gamit & character building',
        'Counseling',
        'privilege suspension'
      ],
    },
  },

  {
    id: 'VG027',
    name: 'Pagbasag ng salamin at pagputol ng toothbrush na maaring gamiting panaksak at paggawa o pagpasok ng matutulis na bagay sa loob ng shelter',
    category: 'Major',
    description: 'Pagbasag ng salamin at pagputol ng toothbrush na maaring gamiting panaksak at paggawa o pagpasok ng matutulis na bagay sa loob ng shelter',
    interventions: {
      '1st': [
        'Pagpalit/Pagbayad ng nasirang gamit',
        '1 day isolation',
        'privilege suspension',
        'psychosocial activity'
      ],
      '2nd': [
        'Pagpalit/Pagbayad ng nasirang gamit',
        '2 days isolation',
        'privilege suspension',
        'psychosocial activity'
      ],
      '3rd': [
        'Pagpalit/Pagbayad ng nasirang gamit',
        '1 week Privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG028',
    name: 'Paglalagay ng tattoo at piercing o bulitas sa anumang bahagi ng katawan',
    category: 'Major',
    description: 'Paglalagay ng tattoo at piercing o bulitas sa anumang bahagi ng katawan',
    interventions: {
      '1st': [
        'Laundry of Bedsheets and towels',
        'psychosocial activity'
      ],
      '2nd': [
        'Laundry of Bedsheets and towels',
        '1week privilege suspension',
        'psychosocial activity'
      ],
      '3rd': [
        'Laundry of Bedsheets and towels',
        '2weeks Privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG029',
    name: 'Pagkuha ng supplies ng shelter gaya ng pagkain, kubyertos, parte ng appliances, office supplies (ballpen, pentelpen)',
    category: 'Major',
    description: 'Pagkuha ng supplies ng shelter gaya ng pagkain, kubyertos, parte ng appliances, office supplies (ballpen, pentelpen)',
    interventions: {
      '1st': [
        '1 day household chores',
        'Laundry of bedsheets and towels',
        'psychosocial activity'
      ],
      '2nd': [
        '2 days household chores',
        'Laundry of bedsheets and towels',
        'psychosocial activity'
      ],
      '3rd': [
        '3 days household chores',
        'Laundry of bedsheets and towels',
        'privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG030',
    name: 'Pagkuha ng kagamitan ng kapwa residente tulad ng meryenda, damit or ibang gamit',
    category: 'Major',
    description: 'Pagkuha ng kagamitan ng kapwa residente tulad ng meryenda, damit or ibang gamit',
    interventions: {
      '1st': [
        '2 days household chores',
        'Laundry of bedsheets and towels',
        'psychosocial activity'
      ],
      '2nd': [
        '3 days household chores',
        'Laundry of bedsheets and towels',
        'psychosocial activity'
      ],
      '3rd': [
        '4 days household',
        'Laundry of bedsheets and towels',
        'privilege suspension',
        'psychosocial activity'
      ],
    },
  },

  {
    id: 'VG031',
    name: 'Kawalang respeto sa kapwa residente/staff/bisita',
    category: 'Major',
    description: 'Kawalang respeto sa kapwa residente/staff/bisita',
    interventions: {
      '1st': [
        '1 day household chores',
        '1 week privilege suspension',
        'character building',
        'counseling'
      ],
      '2nd': [
        '2 days household chores',
        '2 weeks privilege suspension',
        'character building',
        'counseling'
      ],
      '3rd': [
        '3 days household chores',
        '1 month privilege suspension',
        'character building',
        'counseling',
        '1 day isolation'
      ],
    },
  },

  {
    id: 'VG032',
    name: 'Sexually deviant behavior',
    category: 'Major',
    description: 'Sexually deviant behavior. The offended party might seek legal advice or take legal action against the offender.',
    interventions: {
      '1st': [
        'Subject for medical and/or psychological checkup / treatment',
        'Subject for case conference'
      ],
      '2nd': [
        'Subject for medical and/or psychological checkup / treatment',
        'Subject for case conference'
      ],
      '3rd': [
        'Subject for medical and/or psychological checkup / treatment',
        'Subject for case conference'
      ],
    },
  },

  {
    id: 'VG033',
    name: 'Pagtanggi na pumirma at gawin ang Intervention',
    category: 'Major',
    description: 'Pagtanggi na pumirma at gawin ang Intervention',
    interventions: {
      '1st': [
        'verbal warning',
        'still required to do the intervention',
        'psychosocial activity'
      ],
      '2nd': [
        '1 week no video call/visitation',
        'still required to do the intervention'
      ],
      '3rd': [
        '2 weeks no video call/ visitation',
        'still required to do the intervention'
      ],
    },
  },
];

function parseGuideRequirement(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();

  let duration = null;
  let unit = null;

  // Supports the exact guide's forms such as "1day", "1-day", "2weeks", "3 mins".
  const durationMatch = lower.match(
    /(\d+)\s*[-]?\s*(minute|minutes|min|mins|day|days|week|weeks|month|months|meal|meals)/
  );

  if (durationMatch) {
    duration = Number(durationMatch[1]);
    const rawUnit = durationMatch[2];

    if (rawUnit.startsWith('min')) unit = 'Minute(s)';
    else if (rawUnit.startsWith('day')) unit = 'Day(s)';
    else if (rawUnit.startsWith('week')) unit = 'Week(s)';
    else if (rawUnit.startsWith('month')) unit = 'Month(s)';
    else if (rawUnit.startsWith('meal')) unit = 'Meal(s)';
  }

  const requiresPsychosocial =
    lower.includes('psychosocial activity') ||
    lower.includes('psychosocial activities');

  const requiresPsychological =
    lower.includes('psychological') ||
    lower.includes('psychologist') ||
    lower.includes('psychological checkup');

  const requiresMedical =
    lower.includes('medical') ||
    lower.includes('drug test') ||
    lower.includes('treatment') ||
    lower.includes('medication');

  const requiresCaseConference = lower.includes('case conference');
  const requiresIsolation = lower.includes('isolation');
  const requiresPrivilegeSuspension = lower.includes('privilege suspension');
  const requiresPrivilegeRestriction =
    lower.includes('no watching tv') ||
    lower.includes('no use of tablet') ||
    lower.includes('no tablet use') ||
    lower.includes('no video call') ||
    lower.includes('no phone call') ||
    lower.includes('no visitation') ||
    lower.includes('no merienda');
  const requiresHouseholdChores = lower.includes('household chores');
  const requiresCleaning =
    lower.includes('cleaning') ||
    lower.includes('laundry') ||
    lower.includes('cr cleaning');
  const requiresConfiscation =
    lower.includes('confiscate') ||
    lower.includes('confiscation') ||
    lower.includes('safe keeping') ||
    lower.includes('pagsamsam') ||
    lower.includes('pagsamsam');

  let interventionType = 'Other';

  if (requiresPsychosocial) {
    interventionType = 'Psychosocial Activity';
  } else if (requiresIsolation) {
    interventionType = 'Isolation';
  } else if (requiresPrivilegeSuspension) {
    interventionType = 'Privilege Suspension';
  } else if (requiresPrivilegeRestriction) {
    interventionType = 'Privilege Restriction';
  } else if (requiresHouseholdChores) {
    interventionType = 'Household Chores';
  } else if (requiresCleaning) {
    interventionType = 'Cleaning';
  } else if (requiresConfiscation) {
    interventionType = 'Confiscation';
  } else if (lower.includes('counsel')) {
    interventionType = 'Dialogue/Counseling';
  } else if (lower.includes('referral')) {
    interventionType = 'Referral';
  }

  const storedDetails = interventionType === 'Psychosocial Activity' ? '' : raw;

  return {
    interventionType,
    duration,
    unit,
    metadata: {
      officialSeed: true,
      officialText: storedDetails,
      rawText: storedDetails,
      requiresPsychosocial,
      requiresPsychological,
      requiresMedical,
      requiresCaseConference,
      requiresIsolation,
      requiresPrivilegeSuspension,
      requiresPrivilegeRestriction,
      requiresHouseholdChores,
      requiresCleaning,
      requiresConfiscation,
      duration,
      unit,
      schedulable:
        requiresPsychosocial ||
        lower.includes('dialogue'),
    },
  };
}

async function nextSeedGuideInterventionId(connection) {
  const [rows] = await connection.query('SELECT id FROM guide_interventions');
  let maxNumber = 0;
  for (const row of rows) {
    const match = String(row.id || '').match(/^GI(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  let next = maxNumber + 1;
  const used = new Set(rows.map((row) => String(row.id || '')));
  while (used.has(`GI${String(next).padStart(3, '0')}`)) next += 1;
  return `GI${String(next).padStart(3, '0')}`;
}

async function seedOfficialViolationGuide() {
  const connection = await pool.getConnection();

  try {
    await ensureViolationGuideTables();
    await connection.beginTransaction();

    let createdGuides = 0;
    let updatedGuides = 0;
    let createdInterventions = 0;
    let repairedInterventions = 0;

    for (const guide of OFFICIAL_VIOLATION_GUIDE) {
      const [existingGuideRows] = await connection.query(
        'SELECT * FROM violation_guide WHERE id = ? LIMIT 1',
        [guide.id]
      );

      if (existingGuideRows.length === 0) {
        await connection.query(
          `INSERT INTO violation_guide
            (id, name, category, description, status, createdBy, updatedBy)
           VALUES (?, ?, ?, ?, 'Active', 'system', 'system')`,
          [guide.id, guide.name, guide.category, guide.description || null]
        );
        createdGuides += 1;
      } else if (
        existingGuideRows[0].createdBy === 'system' &&
        existingGuideRows[0].updatedBy === 'system'
      ) {
        // Repair/reactivate an earlier system seed without overwriting a guide
        // that a real user has already edited.
        await connection.query(
          `UPDATE violation_guide
           SET name = ?, category = ?, description = ?, updatedBy = 'system', updatedAt = NOW()
           WHERE id = ?`,
          [guide.name, guide.category, guide.description || null, guide.id]
        );
        updatedGuides += 1;
      }

      for (const offenseLevel of ['1st', '2nd', '3rd']) {
        const requirements = guide.interventions?.[offenseLevel] || [];
        const [existingInterventionRows] = await connection.query(
          `SELECT *
           FROM guide_interventions
           WHERE guideId = ? AND offenseLevel = ?
           ORDER BY createdAt ASC`,
          [guide.id, offenseLevel]
        );

        const existingOfficialTexts = existingInterventionRows.map((row) => {
          let metadata = row.metadata;
          if (typeof metadata === 'string') {
            try { metadata = JSON.parse(metadata); } catch { metadata = null; }
          }
          return String(metadata?.officialText || metadata?.rawText || '').trim();
        });

        const officialTexts = requirements.map((item) => String(item).trim());
        const isExactMatch =
          existingOfficialTexts.length === officialTexts.length &&
          existingOfficialTexts.every((text, index) => text === officialTexts[index]);

        if (isExactMatch) continue;

        const guideIsSystemOwned =
          existingGuideRows.length === 0 ||
          (existingGuideRows[0].createdBy === 'system' &&
            existingGuideRows[0].updatedBy === 'system');

        // Repair only system-seeded records. Never destroy a user-authored
        // intervention configuration during server startup.
        if (guideIsSystemOwned && existingInterventionRows.length > 0) {
          await connection.query(
            'DELETE FROM guide_interventions WHERE guideId = ? AND offenseLevel = ?',
            [guide.id, offenseLevel]
          );
          repairedInterventions += 1;
        } else if (existingInterventionRows.length > 0) {
          // A user-authored set already exists. Leave it untouched.
          continue;
        }

        for (const requirement of requirements) {
          const parsed = parseGuideRequirement(requirement);
          await connection.query(
            `INSERT INTO guide_interventions
              (id, guideId, offenseLevel, interventionType, duration, unit, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              await nextSeedGuideInterventionId(connection),
              guide.id,
              offenseLevel,
              parsed.interventionType,
              parsed.duration,
              parsed.unit,
              JSON.stringify(parsed.metadata),
            ]
          );
          createdInterventions += 1;
        }
      }
    }

    await connection.commit();
    console.log(
      `Official SCH violation guide sync complete: ${OFFICIAL_VIOLATION_GUIDE.length} official violations checked; ${createdGuides} added; ${updatedGuides} system guide(s) repaired; ${createdInterventions} intervention requirement(s) added; ${repairedInterventions} incomplete offense sets repaired.`
    );
  } catch (error) {
    await connection.rollback();
    console.error('Official SCH violation guide sync failed:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}

async function seedResidentAssignments() {
  try {
    const [houseparents] = await pool.query(
      "SELECT id FROM users WHERE role = 'houseparent' AND status = 'Active'"
    );
    if (houseparents.length === 0) {
      console.log('No active houseparent users found, skipping resident assignments');
      return;
    }
    const [children] = await pool.query("SELECT id FROM children WHERE status = 'Active'");
    if (children.length === 0) {
      console.log('No active children found, skipping resident assignments');
      return;
    }
    const [existing] = await pool.query("SELECT userId, residentId FROM residentAssignments WHERE status = 'Active'");
    const existingKeys = new Set(existing.map(r => `${r.userId}|${r.residentId}`));
    let createdCount = 0;
    for (const child of children) {
      for (const hp of houseparents) {
        const key = `${hp.id}|${child.id}`;
        if (!existingKeys.has(key)) {
          const [allAssns] = await pool.query('SELECT id FROM residentAssignments');
          const id = generateId('ASN', allAssns);
          // The value has to be 'houseparent': that is the only assignmentType
          // any reader grants caseload scope on (utils/residentScope.js,
          // assignmentController, notificationService), and it is what the
          // assignment UI itself posts. This used to write 'household', which no
          // reader accepts, so every row this function created was inert — a
          // Houseparent signed in and saw an empty caseload.
          //
          // Consequence worth knowing before seeding a demo: the loop below is
          // the full houseparent x child cross product, so with a live value
          // every seeded Houseparent is assigned every Active resident. That is
          // intentional here — the seed exists to give each demo login something
          // to look at — but it means seeded data cannot be used to demonstrate
          // per-Houseparent isolation. Real assignments made through the UI are
          // one-resident-at-a-time and are unaffected.
          await pool.query(
            `INSERT INTO residentAssignments (id, residentId, userId, assignmentType, status, startAt, source, createdBy)
             VALUES (?, ?, ?, 'houseparent', 'Active', NOW(), 'system', 'system')`,
            [id, child.id, hp.id]
          );
          createdCount++;
        }
      }
    }
    console.log(`Created ${createdCount} resident assignments (houseparent -> child)`);
  } catch (error) {
    console.error('Resident assignments seeding failed:', error.message);
  }
}

async function seedDatabase() {
  try {
    console.log('Checking default users...');
    
    for (const user of DEFAULT_USERS) {
      const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [user.username]);
      
            if (existing.length === 0) {
        const hashedPassword = await bcrypt.hash(user.password, 10);
        await pool.query(
          'INSERT INTO users (id, username, password, role, status, createdDate, accessibleModules) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
          [user.id, user.username, hashedPassword, user.role, user.status, JSON.stringify(user.accessibleModules || [])]
        );
        console.log(`Created user: ${user.username}`);
      } else {
        const [row] = await pool.query('SELECT password FROM users WHERE username = ?', [user.username]);
        const stored = row[0]?.password;
        if (stored && !stored.startsWith('$2')) {
          const hashedPassword = await bcrypt.hash(user.password, 10);
          await pool.query('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, user.username]);
          console.log(`Rehashed legacy password for: ${user.username}`);
        }
        console.log(`User exists: ${user.username}`);
      }
    }

    // NOTE: there is deliberately no Houseparent whitelist here.
    //
    // This step used to force every `role = 'houseparent'` account whose
    // username was not literally "HP 1"…"HP 10" to status = 'Inactive'. That
    // silently disabled Houseparents created through Account Management on the
    // next seed, on top of the username filter the caseload endpoint used to
    // apply — so a newly created Houseparent could never be assigned. Status is
    // the operator's decision: an account is selectable because its role is
    // Houseparent AND it is Active, and both are set from Account Management.

    await seedResidentAssignments();
    await seedOfficialViolationGuide();
    console.log('Database seeding complete!');
  } catch (error) {
    console.error('Seeding failed:', error.message);
  }
}

module.exports = { seedDatabase, DEFAULT_USERS };


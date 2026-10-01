/* ═══════════════════════════════════════════════════════════════
   AP2 shared config — load this BEFORE auth.js and any page script:
   <script src="https://effimalik.github.io/fh_supabase/shared/config.js"></script>
   Pages read it as CONFIG.<key>.
═══════════════════════════════════════════════════════════════ */
window.CONFIG = Object.freeze({
  SUPABASE_URL     : 'https://vqmbnegrqfzphaawwogj.supabase.co',
  SUPABASE_KEY     : 'sb_publishable_57UwCMxEzrWmPdkLf85B_A_7h166c55', // publishable key — safe in browser
  GOOGLE_CLIENT_ID : '743775120253-lr54jgst59jqr5s61vc3i4o3rnfn596a.apps.googleusercontent.com',

  /* emp_log table (all columns are text) */
  EMP_TABLE   : 'emp_log',
  EMP_DATASET : 'ap2_employee',
  EMP_COLUMNS : {
    empId    : 'emp_id',
    name     : 'Name',
    eid      : 'Eid_Number',
    dob      : 'Date_Of_Birth',
    mobile   : 'Uae_Mobile',
    emergency: 'Emergency_Mobile',
    ref      : 'Reference',
    checkout : 'Checkout_Exception',
    hrStatus : 'Hr_Status',
    createdAt: 'Created_At',
  },
  HR_STATUSES : ['Active', 'Inactive'],
  TZ_OFFSET   : '+04:00',   // UAE time, used for Created_At
});

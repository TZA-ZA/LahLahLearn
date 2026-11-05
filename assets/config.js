/* LahLahLearn settings.
   Cloud is ON: accounts, cloud save, Care Circle invites, emails, payments and Pip's AI run on Supabase
   (project "lahlahlearn", Singapore). Clear supabaseUrl to run fully on the device again.
   The publishable key is meant to be public; row level security protects the data. */
window.LLL_CONFIG = {
  supabaseUrl: 'https://vuhvvzmmnndrgxoywfem.supabase.co',
  supabaseAnonKey: 'sb_publishable_CS8s0wmGsWm7dDgtCSlepQ_dxL9IanN',
  google: true,       // button appears automatically once Google is enabled in Supabase Auth
  apple: true,        // button appears automatically once Apple is enabled in Supabase Auth
  pipAI: true,        // Pip answers with AI through the pip-chat function
  contactEmail: 'lahlahlearn@gmail.com'
};

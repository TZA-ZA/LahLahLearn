/* LahLahLearn settings.
   Leave supabaseUrl and supabaseAnonKey empty to run fully on this device (no accounts, no cloud).
   Fill them in (Supabase dashboard > Project Settings > API) to turn on accounts, cloud save,
   Care Circle invites, emails, payments and Pip's AI. The anon key is safe to publish. */
window.LLL_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  google: false,      // true once Google sign-in is enabled in Supabase Auth
  apple: false,       // true once Apple sign-in is enabled in Supabase Auth
  pipAI: true,        // Pip answers with AI through the pip-chat function
  contactEmail: 'hello@lahlahlearn.com'
};

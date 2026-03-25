-- Seed initial admin if not exists
-- Username: admin@offramp.com
-- Password: 123456
INSERT INTO public.admins (username, password_hash, role)
SELECT 'admin@offramp.com', '$2b$10$jIXwZQO0yJDp042cmS9gtuzU7.NBYe1QAmCZcfkmTIks/4vfjQpXC', 'superadmin'
WHERE NOT EXISTS (SELECT 1 FROM public.admins WHERE username = 'admin@offramp.com');

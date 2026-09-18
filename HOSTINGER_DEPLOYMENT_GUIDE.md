# Deploying EasyX to Hostinger

This guide covers deploying EasyX to **Hostinger**. Because EasyX is a full-stack application with an Express backend, WebSockets, background cron workers, and Supabase integration, **Hostinger VPS** is the recommended option. We also provide instructions for **Hostinger Cloud/Web Hosting (with Node.js in hPanel)**.

---

## 1. Export Your Project from AI Studio

1. In Google AI Studio Build, click the **Settings / Menu** icon at the top right.
2. Choose **Export to GitHub** or **Download as ZIP**.
3. If downloading as ZIP, extract it on your local computer.

---

## Option A: Hostinger VPS (Recommended)

Hostinger VPS (Ubuntu 22.04 or 24.04) provides full control, persistent background processes (for maturity sweeps & real-time updates), and standard Nginx SSL routing.

### Step 1: Connect to Your VPS via SSH
```bash
ssh root@YOUR_SERVER_IP
```

### Step 2: Install Node.js (v20+ LTS) and Git
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx
npm install -g pm2
```

Verify versions:
```bash
node -v   # Should be v20.x or higher
npm -v
pm2 -v
```

### Step 3: Clone or Upload Your Code
Create a project folder:
```bash
mkdir -p /var/www/easyx
cd /var/www/easyx
```

- **Via Git**: `git clone <your-repo-url> .`
- **Via SCP / FileZilla**: Upload all extracted project files to `/var/www/easyx`.

### Step 4: Configure Environment Variables
Create a `.env` file in `/var/www/easyx`:
```bash
nano .env
```

Paste your production credentials (copying from `.env.example`):
```env
NODE_ENV=production
JWT_SECRET=your_super_strong_random_secret_at_least_32_chars_long
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
ADMIN_EMAIL=subamcollection@gmail.com
ADMIN_PASSWORD=your_admin_password
GEMINI_API_KEY=your_gemini_key_if_used
RESEND_API_KEY=your_resend_key_if_used
SCHEDULER_SECRET=your_scheduler_secret_min_16_chars
```
Press `Ctrl + O` to save, then `Ctrl + X` to exit.

### Step 5: Install Dependencies & Build
```bash
npm install
npm run build
```
This builds the client assets to `dist/` and bundles the server into `dist/server.cjs`.

### Step 6: Start the Application with PM2
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```
Run `pm2 status` to verify the app status is `online`.
View server logs with:
```bash
pm2 logs easyx
```

### Step 7: Configure Nginx Reverse Proxy with Domain & SSL
1. Create an Nginx site configuration:
```bash
sudo nano /etc/nginx/sites-available/easyx
```

2. Add the following configuration (replace `yourdomain.com` with your actual domain):
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

3. Enable the site and reload Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/easyx /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

4. Install free SSL with Certbot:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Your app is now live at `https://yourdomain.com`!

---

## Option B: Hostinger Cloud / Web Hosting (hPanel with Node.js)

If your Hostinger plan includes the **Node.js application manager** in hPanel:

1. **Upload Files**:
   - In hPanel, open **File Manager** or connect via FTP.
   - Upload your project files to your domain folder (e.g. `public_html` or a dedicated app directory).
2. **Access Node.js in hPanel**:
   - In hPanel, search for **Node.js**.
   - Click **Create Application**.
3. **Configure the Node Application**:
   - **Node.js Version**: Select **20.x** (or latest LTS).
   - **Application Mode**: **Production**.
   - **Application Root**: The directory where files were uploaded.
   - **Application Startup File**: `dist/server.cjs`
4. **Environment Variables**:
   - Under the Environment Variables section in hPanel, add all variables from `.env.example` (such as `NODE_ENV=production`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, etc.).
5. **Install & Build**:
   - In the Node.js settings, click **NPM Install**.
   - Run the build command:
     ```bash
     npm run build
     ```
6. **Start Application**:
   - Click **Restart Application** in hPanel.

---

## Maintenance & Updates
Whenever you make updates to the codebase:
```bash
git pull
npm install
npm run build
pm2 restart easyx
```

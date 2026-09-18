# Deploying to Hostinger via GitHub

This guide walks you through deploying **EasyX** to Hostinger directly using **GitHub** (with continuous deployment via Git or GitHub Actions).

---

## Method 1: Hostinger VPS with GitHub Auto-Deploy (Recommended)

This gives you a full-stack, continuous deployment workflow where every `git push origin main` automatically updates your live site.

### 1. Export & Push Your Code to GitHub
1. In Google AI Studio Build, click **Settings** / **Export** in the top-right corner.
2. Select **Export to GitHub** and connect your GitHub repository (e.g. `https://github.com/your-username/easyx`).

---

### 2. Initial Server Setup on Hostinger VPS
SSH into your Hostinger VPS:
```bash
ssh root@YOUR_SERVER_IP
```

Install prerequisites (Node.js 20, Git, PM2, and Nginx):
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx
npm install -g pm2
```

Clone your GitHub repository into `/var/www/easyx`:
```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/your-username/easyx.git
cd /var/www/easyx
```

---

### 3. Set Up Production `.env`
Create the `.env` file on the server (never commit `.env` to GitHub):
```bash
nano .env
```
Paste your secrets:
```env
NODE_ENV=production
JWT_SECRET=your_secure_random_secret_at_least_32_characters_long
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
ADMIN_EMAIL=subamcollection@gmail.com
ADMIN_PASSWORD=your_admin_password
GEMINI_API_KEY=your_gemini_api_key_if_used
RESEND_API_KEY=your_resend_api_key_if_used
SCHEDULER_SECRET=your_scheduler_secret_min_16_chars
```
Press `Ctrl + O`, `Enter` to save, and `Ctrl + X` to exit.

---

### 4. Build & Start with PM2
```bash
npm install
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

### 5. Configure Nginx Reverse Proxy
```bash
sudo nano /etc/nginx/sites-available/easyx
```
Add:
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
Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/easyx /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```
Install SSL:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

### 6. Enable Automated Deployments via GitHub Actions (CI/CD)

The repository now contains `.github/workflows/deploy.yml`.

To enable automatic deployment on every push:
1. Go to your GitHub repository on github.com.
2. Click **Settings** &rarr; **Secrets and variables** &rarr; **Actions** &rarr; **New repository secret**.
3. Add the following secrets:
   - `HOSTINGER_VPS_IP`: Your Hostinger VPS Public IP address.
   - `HOSTINGER_VPS_USER`: `root` (or your sudo deploy user).
   - `HOSTINGER_SSH_PRIVATE_KEY`: Your private SSH key (e.g. contents of `~/.ssh/id_rsa` or generated key).

Now, whenever you push code changes to the `main` branch on GitHub, GitHub Actions will automatically log in to your Hostinger VPS, pull the latest code, build it (`npm run build`), and restart PM2!

---

## Method 2: Hostinger hPanel Git Deployment (Web / Cloud Hosting)

If you are using Hostinger Shared or Cloud Hosting with hPanel:

1. **In Hostinger hPanel**:
   - Go to **Websites** &rarr; select your domain.
   - In the sidebar search bar, type **Git**.
   - Under **Create a New Repository**:
     - **Repository URL**: Enter your GitHub repo clone URL (e.g. `https://github.com/your-username/easyx.git`).
     - **Branch**: `main`
     - **Install Directory**: your app root directory.
   - Click **Create**.
2. **Auto-Deployment Webhook**:
   - After creating, Hostinger displays a **Webhook URL**.
   - Copy this Webhook URL.
   - Go to your GitHub repository &rarr; **Settings** &rarr; **Webhooks** &rarr; **Add webhook**.
   - Paste the Hostinger Webhook URL.
   - Content type: `application/json`.
   - Events: Just the `push` event.
   - Save the webhook.
3. **Build Script in Node.js Manager**:
   - In hPanel, go to **Node.js**.
   - Ensure your startup file is set to `dist/server.cjs`.
   - Run `npm install` and `npm run build` after pulling.

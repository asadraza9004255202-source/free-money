# AdReward — chalane ka tarika

1. Node.js install karo (v18+).
2. Is folder me terminal kholo:
   ```
   npm install
   ADMIN_PASSWORD=apna_password npm start
   ```
   (Windows PowerShell: `$env:ADMIN_PASSWORD="apna_password"; npm start`)
3. User page: http://localhost:3000
4. Admin panel: http://localhost:3000/admin.html

## Flow
- User form bharta hai: Full name, mobile number, bank/UPI QR photo.
- 25 ads dekhne hain, har ad kam se kam 10 second (server check karta hai, cheating nahi chalegi).
- Beech me page chhode to "Task incomplete" error aata hai, dobara 1 se shuru.
- 25 poore hone par admin me "Task poora" dikhta hai + QR dikhta hai.
- Admin apne UPI app se ₹5 bhejta hai, fir "Green tick bhejo" dabata hai -> user ke screen par animation.

## Asli ads lagana
`public/index.html` me `adHtml()` function dhundo — wahan apne ad network ka code lagao.

## Live karne ke liye
Render / Railway / VPS par deploy karo (HTTPS ke saath). ADMIN_PASSWORD zaroor badlo.
data.json me users ki details (QR samet) save hoti hain — isko surakshit rakho.

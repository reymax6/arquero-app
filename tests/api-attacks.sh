B="${BASE_URL:-http://localhost:3000}"
PW="${ADMIN_PASSWORD:-test-secret-123}"
p(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
post(){ curl -s -o /tmp/b -w "%{http_code}" -X POST "$B$1" -H 'Content-Type: application/json' -d "$2"; echo " -> $(head -c 200 /tmp/b)"; }

p "1. Customer data endpoints without login"
echo -n "GET /api/bookings  : "; curl -s -o /tmp/b -w "%{http_code}" $B/api/bookings; echo " -> $(head -c 120 /tmp/b)"
echo -n "GET /api/orders    : "; curl -s -o /tmp/b -w "%{http_code}" $B/api/orders; echo " -> $(head -c 120 /tmp/b)"
echo -n "with WRONG password: "; curl -s -o /tmp/b -w "%{http_code}" -u admin:wrong $B/api/bookings; echo " -> $(head -c 80 /tmp/b)"
echo -n "with RIGHT password: "; curl -s -o /tmp/b -w "%{http_code}" -u admin:$PW $B/api/bookings; echo " -> $(head -c 80 /tmp/b)"

p "2. Price tampering (claiming a \$22 dish costs 1 cent)"
ID=$(curl -s $B/api/menu | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(Object.values(m)[1][0].id)})")
post /api/orders "{\"name\":\"Test Buyer\",\"phone\":\"09171234567\",\"orderType\":\"dine-in\",\"items\":[{\"id\":\"$ID\",\"qty\":1,\"price\":0.01}]}"

p "3. SQL injection in the date field"
echo -n "availability injection: "; curl -s -o /tmp/b -w "%{http_code}" "$B/api/availability?date=');%20DROP%20TABLE%20bookings;--"; echo " -> $(head -c 120 /tmp/b)"
echo -n "bookings table alive  : "; curl -s -u admin:$PW -o /tmp/b -w "%{http_code}" $B/api/bookings; echo ""

p "4. Bad dates"
for D in 2020-01-01 not-a-date 2525-01-01 2026-02-31 2026-11-30; do
  printf "  %-12s : " "$D"
  post /api/bookings "{\"courtId\":\"court-1\",\"date\":\"$D\",\"time\":\"3:00 PM\",\"name\":\"Rey Test\",\"phone\":\"09171234567\",\"partySize\":\"doubles\"}"
done

p "5. A time that has already passed today (server clock is ~2:25 PM)"
post /api/bookings "{\"courtId\":\"court-1\",\"date\":\"2026-08-14\",\"time\":\"6:00 AM\",\"name\":\"Rey Test\",\"phone\":\"09171234567\",\"partySize\":\"doubles\"}"

p "6. Absurd quantity (999,999,999 portions of trout)"
post /api/orders "{\"name\":\"Test Buyer\",\"phone\":\"09171234567\",\"orderType\":\"dine-in\",\"items\":[{\"id\":\"$ID\",\"qty\":999999999}]}"

p "7. Junk names, phones, and order types"
printf "  10k-char name  : "; post /api/orders "{\"name\":\"$(head -c 10000 /dev/zero | tr '\0' 'A')\",\"phone\":\"09171234567\",\"orderType\":\"dine-in\",\"items\":[{\"id\":\"$ID\",\"qty\":1}]}"
printf "  spaces only    : "; post /api/orders "{\"name\":\"     \",\"phone\":\"    \",\"orderType\":\"dine-in\",\"items\":[{\"id\":\"$ID\",\"qty\":1}]}"
printf "  script phone   : "; post /api/orders "{\"name\":\"Ok Name\",\"phone\":\"<script>alert(1)</script>\",\"orderType\":\"dine-in\",\"items\":[{\"id\":\"$ID\",\"qty\":1}]}"
printf "  fake ordertype : "; post /api/orders "{\"name\":\"Ok Name\",\"phone\":\"09171234567\",\"orderType\":\"free-food\",\"items\":[{\"id\":\"$ID\",\"qty\":1}]}"
printf "  fake party     : "; post /api/bookings "{\"courtId\":\"court-1\",\"date\":\"2026-08-20\",\"time\":\"3:00 PM\",\"name\":\"Ok Name\",\"phone\":\"09171234567\",\"partySize\":\"99 players\"}"

p "8. Malformed JSON — does it leak our file paths?"
curl -s -X POST $B/api/orders -H 'Content-Type: application/json' -d '{broken' | head -c 400; echo ""

p "9. Unknown API route"
curl -s -o /tmp/b -w "%{http_code}" $B/api/nope; echo " -> $(cat /tmp/b)"

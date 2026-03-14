const express = require("express");
const mysql = require("mysql2");

const app = express();

app.use(express.json());
app.use(express.static("public"));

app.use((req, res, next) => {
res.set('Cache-Control', 'no-store');
next();
});

const db = mysql.createConnection({
host: "localhost",
user: "root",
password: "123456789",
database: "raspberry_manager"
});

db.connect(err => {
if (err) {
console.error("Error MySQL:", err);
return;
}
console.log("Conectado a MySQL");
});

app.post("/api/raspberry",(req,res)=>{

const {id} = req.body;

db.query(
"INSERT INTO raspberries (id,created_at) VALUES (?,NOW())",
[id],
(err,result)=>{

if(err){
return res.status(400).json({error:"Raspberry ya registrada"});
}

res.json({status:"ok"});

});

});

app.get("/api/raspberries",(req,res)=>{

db.query(`
SELECT 
id,
last_seen,
created_at,
CASE
WHEN last_seen IS NOT NULL 
AND TIMESTAMPDIFF(SECOND,last_seen,NOW()) < 60
THEN 'Online'
ELSE 'Offline'
END AS estado
FROM raspberries
`,(err,rows)=>{

if(err){
return res.status(500).json(err);
}

res.json(rows);

});

});

app.post("/api/heartbeat",(req,res)=>{

const {id} = req.body;

db.query(
"UPDATE raspberries SET last_seen=NOW() WHERE id=?",
[id],
(err)=>{

if(err){
return res.status(500).json(err);
}

res.json({status:"ok"});

});

});

app.listen(3000,()=>{
console.log("Servidor iniciado en puerto 3000");
});
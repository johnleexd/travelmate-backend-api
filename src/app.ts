import express from 'express';
import cors from 'cors';

const app = express();

// I-enable ang CORS para sa imong Next.js frontend
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));

// Para makadawat og JSON data gikan sa frontend
app.use(express.json());

// Sample Route para sa pag-test
app.get('/', (req, res) => {
    res.json({ message: "Hello gikan sa TravelMate Backend!" });
});

export default app;
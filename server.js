const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const sharp = require('sharp');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => res.send('Сервер Mangal House работает, картинки летят в облако!'));

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- ОБНОВЛЕННАЯ ЗАГРУЗКА КАРТИНОК (ПРЯМО В ВЕЧНЫЙ SUPABASE) ---
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = uniqueSuffix + '.webp';

    try {
        // 1. Сжимаем картинку прямо в оперативной памяти
        const webpBuffer = await sharp(req.file.buffer)
            .resize(800, null, { withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

        // 2. Отправляем напрямую в Supabase Storage
        const uploadUrl = `${process.env.SUPABASE_URL}/storage/v1/object/menu-images/${filename}`;
        const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
                'apikey': process.env.SUPABASE_ANON_KEY,
                'Content-Type': 'image/webp'
            },
            body: webpBuffer
        });

        if (!uploadResponse.ok) {
            const errText = await uploadResponse.text();
            console.error('Ошибка Supabase:', errText);
            return res.status(500).json({ error: 'Ошибка сохранения в облаке' });
        }

        // 3. Формируем публичную ссылку на картинку
        const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/menu-images/${filename}`;

        res.json({ imageUrl });
    } catch (error) {
        console.error('Ошибка обработки картинки:', error);
        res.status(500).json({ error: 'Ошибка сервера при загрузке' });
    }
});

app.post('/api/orders', async (req, res) => {
    const { table, total, items } = req.body;
    try {
        await pool.query(
            'INSERT INTO orders (table_number, total_price, order_details) VALUES ($1, $2, $3)',
            [table, total, JSON.stringify(items)]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка сохранения заказа:', error);
        res.status(500).json({ error: 'Ошибка сохранения заказа' });
    }
});

app.get('/api/menu', async (req, res) => {
    try {
        const settingsRes = await pool.query('SELECT * FROM restaurant_settings LIMIT 1');
        const rawSettings = settingsRes.rows[0] || {};

        const settings = {
            ...rawSettings,
            logo: rawSettings.logo_url,
            whatsappNumber: rawSettings.whatsapp_number,
            phoneNumber: rawSettings.phone_number,
            instagram: rawSettings.instagram_url,
            tiktok: rawSettings.tiktok_url,
            restaurantName: rawSettings.restaurant_name_ru,
            restaurantName_ru: rawSettings.restaurant_name_ru,
            restaurantName_kz: rawSettings.restaurant_name_kz,
            welcomeTitle: rawSettings.welcome_title_ru,
            welcomeTitle_ru: rawSettings.welcome_title_ru,
            welcomeTitle_kz: rawSettings.welcome_title_kz,
            welcomeDescription: rawSettings.welcome_desc_ru,
            welcomeDescription_ru: rawSettings.welcome_desc_ru,
            welcomeDescription_kz: rawSettings.welcome_desc_kz,
            ui_tilt_enabled: rawSettings.ui_tilt_enabled,
            ui_tilt_strength: rawSettings.ui_tilt_strength,
            ui_shadow_strength: rawSettings.ui_shadow_strength,
            ui_font_choice: rawSettings.ui_font_choice
        };

        const sectionsRes = await pool.query('SELECT * FROM menu_sections ORDER BY sort_order');
        const sections = sectionsRes.rows;

        const dishesRes = await pool.query('SELECT * FROM dishes ORDER BY sort_order');
        const dishes = dishesRes.rows;

        const formattedSections = sections.map(section => ({
            ...section,
            dishes: dishes.filter(dish => dish.section_id === section.id).map(dish => ({
                ...dish,
                image: dish.image_url
            }))
        }));

        res.json({ ...settings, sections: formattedSections });
    } catch (err) {
        console.error('Ошибка при получении меню:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/menu', async (req, res) => {
    const data = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(`
            UPDATE restaurant_settings SET
                restaurant_name_ru = $1,
                restaurant_name_kz = $2,
                welcome_title_ru = $3,
                welcome_title_kz = $4,
                welcome_desc_ru = $5,
                welcome_desc_kz = $6,
                whatsapp_number = $7,
                instagram_url = $8,
                logo_url = $9,
                ui_tilt_enabled = $10,
                ui_tilt_strength = $11
        `, [
            data.restaurantName_ru || data.restaurantName,
            data.restaurantName_kz,
            data.welcomeTitle_ru || data.welcomeTitle,
            data.welcomeTitle_kz,
            data.welcomeDescription_ru || data.welcomeDescription,
            data.welcomeDescription_kz,
            data.whatsappNumber,
            data.instagram,
            data.logo,
            data.ui_tilt_enabled !== false,
            data.ui_tilt_strength || 8
        ]);

        await client.query('DELETE FROM menu_sections');

        if (data.sections && data.sections.length > 0) {
            for (let i = 0; i < data.sections.length; i++) {
                const section = data.sections[i];

                const secRes = await client.query(`
                    INSERT INTO menu_sections (name_ru, name_kz, description_ru, description_kz, sort_order)
                    VALUES ($1, $2, $3, $4, $5) RETURNING id
                `, [
                    section.name_ru || section.name,
                    section.name_kz,
                    section.description_ru || section.description,
                    section.description_kz,
                    i
                ]);

                const newSecId = secRes.rows[0].id;

                if (section.dishes && section.dishes.length > 0) {
                    for (let j = 0; j < section.dishes.length; j++) {
                        const dish = section.dishes[j];
                        await client.query(`
                            INSERT INTO dishes (section_id, name_ru, name_kz, price, description_ru, image_url, is_available, sort_order)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        `, [newSecId, dish.name_ru || dish.name, dish.name_kz, dish.price, dish.description_ru || dish.description, dish.image, dish.available !== false, j]);
                    }
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка сохранения:', err);
        res.status(500).json({ error: 'Ошибка сохранения в БД' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ Сервер Mangal House запущен на порту ${PORT}`);
});

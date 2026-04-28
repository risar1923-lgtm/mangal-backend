const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Проверочные роуты
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => res.send('✅ СЕРВЕР ОБНОВЛЕН: РЕЖИМ ПРЯМЫХ ССЫЛОК GITHUB'));

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false } // Нужно для подключения к Supabase DB
});

// Настройка multer (нам теперь не нужен Sharp, так как ты сам готовишь фото)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

/**
 * ЗАМЕНА ЗАГРУЗКИ В ОБЛАКО
 * Теперь этот роут просто подтверждает получение имени файла.
 * Ты вручную загружаешь фото в public/images/ на GitHub.
 */
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        // Если ты просто вставил имя файла в админке, берем его
        const fileName = req.body.fileName || (req.file ? req.file.originalname : null);
        
        if (!fileName) {
            return res.status(400).json({ error: 'Имя файла не указано' });
        }

        // Формируем путь, который будет указывать на папку внутри твоего сайта
        const imageUrl = `/images/${fileName}`;
        
        console.log('✅ Использование локального изображения:', imageUrl);
        res.json({ imageUrl });
    } catch (error) {
        console.error('❌ Ошибка при обработке пути:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
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
            restaurantName_ru: rawSettings.restaurant_name_ru,
            restaurantName_kz: rawSettings.restaurant_name_kz,
            welcomeTitle_ru: rawSettings.welcome_title_ru,
            welcomeTitle_kz: rawSettings.welcome_title_kz,
            welcomeDescription_ru: rawSettings.welcome_desc_ru,
            welcomeDescription_kz: rawSettings.welcome_desc_kz,
            ui_tilt_enabled: rawSettings.ui_tilt_enabled,
            ui_tilt_strength: rawSettings.ui_tilt_strength
        };

        const sectionsRes = await pool.query('SELECT * FROM menu_sections ORDER BY sort_order');
        const dishesRes = await pool.query('SELECT * FROM dishes ORDER BY sort_order');

        const formattedSections = sectionsRes.rows.map(section => ({
            ...section,
            dishes: dishesRes.rows.filter(dish => dish.section_id === section.id).map(dish => ({
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
                restaurant_name_ru = $1, restaurant_name_kz = $2,
                welcome_title_ru = $3, welcome_title_kz = $4,
                welcome_desc_ru = $5, welcome_desc_kz = $6,
                whatsapp_number = $7, instagram_url = $8,
                logo_url = $9, ui_tilt_enabled = $10, ui_tilt_strength = $11
        `, [
            data.restaurantName_ru || data.restaurantName, data.restaurantName_kz,
            data.welcomeTitle_ru || data.welcomeTitle, data.welcomeTitle_kz,
            data.welcomeDescription_ru || data.welcomeDescription, data.welcomeDescription_kz,
            data.whatsappNumber, data.instagram, data.logo,
            data.ui_tilt_enabled !== false, data.ui_tilt_strength || 8
        ]);

        await client.query('DELETE FROM menu_sections');

        if (data.sections) {
            for (let i = 0; i < data.sections.length; i++) {
                const s = data.sections[i];
                const secRes = await client.query(`
                    INSERT INTO menu_sections (name_ru, name_kz, description_ru, description_kz, sort_order)
                    VALUES ($1, $2, $3, $4, $5) RETURNING id
                `, [s.name_ru || s.name, s.name_kz, s.description_ru || s.description, s.description_kz, i]);

                const newId = secRes.rows[0].id;
                if (s.dishes) {
                    for (let j = 0; j < s.dishes.length; j++) {
                        const d = s.dishes[j];
                        await client.query(`
                            INSERT INTO dishes (section_id, name_ru, name_kz, price, description_ru, image_url, is_available, sort_order)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        `, [newId, d.name_ru || d.name, d.name_kz, d.price, d.description_ru || d.description, d.image, d.available !== false, j]);
                    }
                }
            }
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка сохранения меню:', err);
        res.status(500).json({ error: 'Ошибка сохранения' });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ СЕРВЕР ЗАПУЩЕН: ПОРТ ${PORT}`);
});

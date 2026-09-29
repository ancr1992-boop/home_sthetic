const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb+srv://ancr1992_db_user:3kUEY6d3corv9zal@cluster0.kzxefo2.mongodb.net/home_sthetic?retryWrites=true&w=majority&appName=Cluster0';

async function testConnection() {
  try {
    console.log('Conectando a MongoDB Atlas de HOME STHETIC...');
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('¡CONEXION EXITOSA A MONGODB ATLAS!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error de conexion:', error.message);
    process.exit(1);
  }
}

testConnection();

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Servir la página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= SCHEMAS & MODELS =================

// 1. Cliente con contador de servicios
const clientSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  telefono: { type: String, required: true },
  notas: { type: String, default: '' },
  contadorServicios: {
    type: Map,
    of: Number,
    default: {}
  }
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);

// 2. Citas / Agenda
const appointmentSchema = new mongoose.Schema({
  clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  clienteNombre: { type: String, required: true },
  clienteTelefono: { type: String, default: '' },
  servicio: { type: String, required: true },
  zonas: { type: [String], default: [] },
  valor: { type: Number, required: true },
  operaria: { type: String, required: true },
  fecha: { type: String, required: true }, // YYYY-MM-DD
  hora: { type: String, required: true }, // HH:MM
  duracion: { type: Number, default: 45 },
  estado: { type: String, enum: ['Pendiente', 'Completada', 'Cancelada'], default: 'Pendiente' },
  notas: { type: String, default: '' }
}, { timestamps: true });

const Appointment = mongoose.model('Appointment', appointmentSchema);

// 3. Movimientos de Caja y Ventas
const saleSchema = new mongoose.Schema({
  fecha: { type: String, required: true }, // YYYY-MM-DD
  hora: { type: String, required: true }, // HH:MM
  cliente: { type: String, required: true },
  concepto: { type: String, required: true },
  metodo: { type: String, enum: ['Efectivo', 'Tarjeta Débito', 'Tarjeta Crédito', 'Transferencia'], required: true },
  operaria: { type: String, default: 'General' },
  valor: { type: Number, required: true }
}, { timestamps: true });

const Sale = mongoose.model('Sale', saleSchema);

// 4. Configuración del Centro (Operarias, Servicios y Estado de Caja)
const configSchema = new mongoose.Schema({
  key: { type: String, default: 'main_config', unique: true },
  caja: {
    abierta: { type: Boolean, default: true },
    fondoInicial: { type: Number, default: 50000 },
    fechaApertura: { type: String, default: '' }
  },
  operarias: [{
    nombre: String,
    rol: String
  }],
  servicios: [{
    nombre: String,
    duracion: Number,
    precio: Number
  }]
});

const Config = mongoose.model('Config', configSchema);

// ================= UTILIDADES =================
function getFechaHoy() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Obtener o inicializar la configuración de forma 100% segura
async function getOrCreateConfig() {
  let config = await Config.findOne();
  if (!config) {
    config = await Config.create({
      key: 'main_config',
      caja: {
        abierta: true,
        fondoInicial: 50000,
        fechaApertura: getFechaHoy()
      },
      operarias: [
        { nombre: 'Valentina Restrepo', rol: 'Cosmiatra Especialista' },
        { nombre: 'Camila Morales', rol: 'Especialista Láser & Cejas' },
        { nombre: 'Mariana Duque', rol: 'Masoterapeuta' }
      ],
      servicios: [
        { nombre: 'Depilación Láser', duracion: 45, precio: 50000 },
        { nombre: 'Limpieza Facial Profunda', duracion: 60, precio: 95000 },
        { nombre: 'Masaje Reductor / Moldeador', duracion: 50, precio: 80000 },
        { nombre: 'Hydrafacial Glow', duracion: 60, precio: 150000 }
      ]
    });
  } else {
    let modificado = false;
    if (!config.operarias || !Array.isArray(config.operarias)) {
      config.operarias = [];
      modificado = true;
    }
    if (!config.servicios || !Array.isArray(config.servicios)) {
      config.servicios = [];
      modificado = true;
    }
    // Asegurar operarias de muestra si la lista está vacía
    if (config.operarias.length === 0) {
      config.operarias.push(
        { nombre: 'Valentina Restrepo', rol: 'Cosmiatra Especialista' },
        { nombre: 'Camila Morales', rol: 'Especialista Láser & Cejas' },
        { nombre: 'Mariana Duque', rol: 'Masoterapeuta' }
      );
      modificado = true;
    }
    // Asegurar que exista 'Depilación Láser' con precio base por zona de 50.000
    const tieneLaser = config.servicios.some(s => s.nombre && (s.nombre.toLowerCase().includes('laser') || s.nombre.toLowerCase().includes('láser')));
    if (!tieneLaser) {
      config.servicios.unshift({ nombre: 'Depilación Láser', duracion: 45, precio: 50000 });
      modificado = true;
    }
    if (modificado) {
      await config.save();
    }
  }
  return config;
}

// Inicializar configuración y datos semilla si la base está nueva
async function initDatabaseDefaults() {
  await getOrCreateConfig();

  const clientCount = await Client.countDocuments();
  if (clientCount === 0) {
    const c1 = await Client.create({
      nombre: 'Carolina Gómez',
      telefono: '3104567890',
      notas: 'Piel mixta, sensible en zona T',
      contadorServicios: {
        'Depilación Láser': 4,
        'Láser: Bikini': 4,
        'Láser: Axilas': 4,
        'Limpieza Facial Profunda': 2
      }
    });

    const c2 = await Client.create({
      nombre: 'Laura Mendoza',
      telefono: '3209876543',
      notas: 'Plan 10 sesiones de masaje',
      contadorServicios: {
        'Masaje Reductor / Moldeador': 6,
        'Hydrafacial Glow': 1
      }
    });

    const c3 = await Client.create({
      nombre: 'Sofía Castaño',
      telefono: '3012345678',
      notas: 'Primera valoración',
      contadorServicios: {
        'Limpieza Facial Profunda': 1
      }
    });

    // Citas iniciales para hoy
    const hoy = getFechaHoy();
    await Appointment.create([
      {
        clienteId: c1._id,
        clienteNombre: c1.nombre,
        clienteTelefono: c1.telefono,
        servicio: 'Depilación Láser',
        zonas: ['Bikini', 'Axilas'],
        valor: 100000,
        operaria: 'Camila Morales',
        fecha: hoy,
        hora: '09:00',
        duracion: 45,
        estado: 'Completada',
        notas: 'Sesión #4 de paquete'
      },
      {
        clienteId: c2._id,
        clienteNombre: c2.nombre,
        clienteTelefono: c2.telefono,
        servicio: 'Masaje Reductor / Moldeador',
        zonas: [],
        valor: 80000,
        operaria: 'Mariana Duque',
        fecha: hoy,
        hora: '11:00',
        duracion: 50,
        estado: 'Pendiente',
        notas: 'Traer toalla personal'
      },
      {
        clienteId: c3._id,
        clienteNombre: c3.nombre,
        clienteTelefono: c3.telefono,
        servicio: 'Limpieza Facial Profunda',
        zonas: [],
        valor: 95000,
        operaria: 'Valentina Restrepo',
        fecha: hoy,
        hora: '14:30',
        duracion: 60,
        estado: 'Pendiente',
        notas: 'Valoración inicial'
      }
    ]);

    // Venta inicial registrada
    await Sale.create({
      fecha: hoy,
      hora: '09:50',
      cliente: c1.nombre,
      concepto: 'Depilación Láser (Bikini, Axilas)',
      metodo: 'Tarjeta Débito',
      operaria: 'Camila Morales',
      valor: 100000
    });

    console.log('✓ Datos iniciales de demostración cargados en MongoDB Atlas.');
  }
}

// ================= RUTAS API =================

// 1. Cargar todos los datos de inicio
app.get('/api/bootstrap', async (req, res) => {
  try {
    const hoy = getFechaHoy();
    const config = await getOrCreateConfig();
    const [clientes, citasHoy, ventasHoy] = await Promise.all([
      Client.find().sort({ nombre: 1 }),
      Appointment.find({ fecha: hoy }).sort({ hora: 1 }),
      Sale.find({ fecha: hoy }).sort({ createdAt: -1 })
    ]);

    res.json({
      success: true,
      data: {
        config,
        clientes,
        citas: citasHoy,
        ventas: ventasHoy,
        fechaHoy: hoy
      }
    });
  } catch (error) {
    console.error('Error en bootstrap:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Crear Cliente
app.post('/api/clientes', async (req, res) => {
  try {
    const { nombre, telefono, notas } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del cliente es obligatorio' });
    }
    if (!telefono || !telefono.trim()) {
      return res.status(400).json({ success: false, error: 'El teléfono celular es obligatorio' });
    }
    const nuevo = await Client.create({
      nombre: nombre.trim(),
      telefono: telefono.trim(),
      notas: (notas || '').trim(),
      contadorServicios: {}
    });
    console.log(`✓ Nuevo cliente creado: ${nuevo.nombre} (${nuevo.telefono})`);
    res.json({ success: true, cliente: nuevo });
  } catch (error) {
    console.error('Error al crear cliente:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Crear Cita
app.post('/api/citas', async (req, res) => {
  try {
    const { clienteId, servicio, valor, operaria, fecha, hora, duracion, notas, zonas } = req.body;
    const cliente = await Client.findById(clienteId);
    if (!cliente) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });

    // Si tiene zonas seleccionadas (Depilación Láser), el valor es 50.000 COP por zona
    let finalValor = Number(valor);
    if (zonas && Array.isArray(zonas) && zonas.length > 0) {
      finalValor = zonas.length * 50000;
    }

    const nuevaCita = await Appointment.create({
      clienteId: cliente._id,
      clienteNombre: cliente.nombre,
      clienteTelefono: cliente.telefono,
      servicio: servicio || 'Depilación Láser',
      zonas: Array.isArray(zonas) ? zonas : [],
      valor: finalValor,
      operaria: operaria || 'General',
      fecha: fecha || getFechaHoy(),
      hora: hora || '10:00',
      duracion: Number(duracion) || 45,
      notas: (notas || '').trim(),
      estado: 'Pendiente'
    });

    console.log(`✓ Nueva cita agendada para: ${nuevaCita.clienteNombre} - ${nuevaCita.servicio} ($${nuevaCita.valor})`);
    res.json({ success: true, cita: nuevaCita });
  } catch (error) {
    console.error('Error al crear cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Reprogramar Cita
app.put('/api/citas/:id/reprogramar', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora, operaria } = req.body;
    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    if (hora) cita.hora = hora;
    if (operaria) cita.operaria = operaria;
    await cita.save();

    res.json({ success: true, cita });
  } catch (error) {
    console.error('Error al reprogramar cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Cobrar y Completar Cita (¡Incrementa contador por zona y suma a caja!)
app.post('/api/citas/:id/completar-cobro', async (req, res) => {
  try {
    const { id } = req.params;
    const { valor, metodo } = req.body;

    const cita = await Appointment.findById(id);
    if (!cita) return res.status(404).json({ success: false, error: 'Cita no encontrada' });

    // Actualizar estado de cita
    cita.estado = 'Completada';
    await cita.save();

    // Incrementar CONTADOR de servicios del cliente en MongoDB
    const cliente = await Client.findById(cita.clienteId);
    if (cliente) {
      if (cita.zonas && cita.zonas.length > 0) {
        // Incrementar cada zona seleccionada (ej: "Láser: Bikini")
        cita.zonas.forEach(z => {
          const key = `Láser: ${z}`;
          const actual = cliente.contadorServicios.get(key) || 0;
          cliente.contadorServicios.set(key, actual + 1);
        });
        // Y el contador general de Depilación Láser
        const totalLaser = cliente.contadorServicios.get('Depilación Láser') || 0;
        cliente.contadorServicios.set('Depilación Láser', totalLaser + 1);
      } else {
        const actual = cliente.contadorServicios.get(cita.servicio) || 0;
        cliente.contadorServicios.set(cita.servicio, actual + 1);
      }
      await cliente.save();
    }

    // Registrar en Caja
    const now = new Date();
    const horaStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let concepto = cita.servicio;
    if (cita.zonas && cita.zonas.length > 0) {
      concepto = `${cita.servicio} (${cita.zonas.join(', ')})`;
    }

    const venta = await Sale.create({
      fecha: getFechaHoy(),
      hora: horaStr,
      cliente: cita.clienteNombre,
      concepto: concepto,
      metodo: metodo || 'Efectivo',
      operaria: cita.operaria,
      valor: Number(valor) || cita.valor
    });

    res.json({
      success: true,
      cita,
      cliente,
      venta
    });
  } catch (error) {
    console.error('Error al completar cobro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Apertura de Caja
app.post('/api/caja/apertura', async (req, res) => {
  try {
    const { fondoInicial } = req.body;
    let config = await getOrCreateConfig();
    config.caja.abierta = true;
    config.caja.fondoInicial = Number(fondoInicial) || 0;
    config.caja.fechaApertura = getFechaHoy();
    await config.save();

    res.json({ success: true, caja: config.caja });
  } catch (error) {
    console.error('Error en apertura de caja:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Cobro Rápido Manual en Caja
app.post('/api/caja/venta-rapida', async (req, res) => {
  try {
    const { cliente, concepto, metodo, operaria, valor } = req.body;
    const now = new Date();
    const horaStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const venta = await Sale.create({
      fecha: getFechaHoy(),
      hora: horaStr,
      cliente: cliente || 'Cliente General',
      concepto: concepto || 'Venta Rápida',
      metodo: metodo || 'Efectivo',
      operaria: operaria || 'General',
      valor: Number(valor) || 0
    });

    res.json({ success: true, venta });
  } catch (error) {
    console.error('Error en venta rápida:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Operarias: Crear y Eliminar
app.post('/api/operarias', async (req, res) => {
  try {
    const { nombre, rol } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre de la operaria es obligatorio.' });
    }
    const config = await getOrCreateConfig();
    const nuevaOp = {
      nombre: nombre.trim(),
      rol: (rol && rol.trim()) ? rol.trim() : 'Operaria Especialista'
    };
    config.operarias.push(nuevaOp);
    await config.save();
    console.log(`✓ Nueva operaria agregada: ${nuevaOp.nombre} (${nuevaOp.rol})`);
    res.json({ success: true, operarias: config.operarias });
  } catch (error) {
    console.error('Error al agregar operaria:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/operarias/:id', async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    config.operarias = config.operarias.filter(o => o._id && o._id.toString() !== req.params.id);
    await config.save();
    console.log(`✓ Operaria eliminada id: ${req.params.id}`);
    res.json({ success: true, operarias: config.operarias });
  } catch (error) {
    console.error('Error al eliminar operaria:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Servicios: Crear y Eliminar
app.post('/api/servicios', async (req, res) => {
  try {
    const { nombre, duracion, precio } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ success: false, error: 'El nombre del tratamiento es obligatorio.' });
    }
    const config = await getOrCreateConfig();
    const nuevoServ = {
      nombre: nombre.trim(),
      duracion: Number(duracion) || 45,
      precio: Number(precio) || 50000
    };
    config.servicios.push(nuevoServ);
    await config.save();
    console.log(`✓ Nuevo servicio agregado: ${nuevoServ.nombre} - $${nuevoServ.precio}`);
    res.json({ success: true, servicios: config.servicios });
  } catch (error) {
    console.error('Error al agregar servicio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/servicios/:id', async (req, res) => {
  try {
    const config = await getOrCreateConfig();
    config.servicios = config.servicios.filter(s => s._id && s._id.toString() !== req.params.id);
    await config.save();
    console.log(`✓ Servicio eliminado id: ${req.params.id}`);
    res.json({ success: true, servicios: config.servicios });
  } catch (error) {
    console.error('Error al eliminar servicio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ================= INICIAR SERVIDOR =================
async function startServer() {
  try {
    console.log('Conectando a MongoDB Atlas de HOME STHETIC...');
    await mongoose.connect(MONGODB_URI);
    console.log('✓ Conectado exitosamente a MongoDB Atlas.');

    await initDatabaseDefaults();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌸 HOME STHETIC ejecutándose en: http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Error fatal al iniciar:', error);
  }
}

startServer();

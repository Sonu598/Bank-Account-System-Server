const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["Deposit", "Withdrawal", "Transfer", "Charges"],
    required: true,
  },
  amount: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  balanceAfterTransaction: { type: Number, required: true },
  details: { sender: String, recipient: String },
});

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  pin: { type: String, required: true },
  accountNumber: { type: String, unique: true, required: true },
  balance: { type: Number, default: 0 },
  isLocked: { type: Boolean, default: false },
  lockTime: { type: Date },
  failedAttempts: { type: Number, default: 0 },
  transactions: [transactionSchema],
});

module.exports = mongoose.model("User", userSchema);

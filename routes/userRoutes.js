const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();

// generate account number
const generateAccountNumber = () =>
  `BANK-${Math.floor(1000000 + Math.random() * 9000000)}`;

// User Registration
router.post("/register", async (req, res) => {
  try {
    const { username, pin, initialDeposit = 0 } = req.body;

    // Check if username exists
    if (await User.findOne({ username })) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    const user = new User({
      username,
      pin: hashedPin,
      accountNumber: generateAccountNumber(),
      balance: initialDeposit,
      transactions:
        initialDeposit > 0
          ? [
              {
                type: "Deposit",
                amount: initialDeposit,
                balanceAfterTransaction: initialDeposit,
              },
            ]
          : [],
    });

    await user.save();
    res.status(201).json({
      message: "User registered successfully",
      accountNumber: user.accountNumber,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// User Login
router.post("/login", async (req, res) => {
  try {
    const { username, pin } = req.body;
    const user = await User.findOne({ username });

    if (!user)
      return res.status(400).json({ message: "Invalid username or PIN" });

    if (user.isLocked) {
      const timeDiff = (new Date() - user.lockTime) / (1000 * 60 * 60); // Hours
      if (timeDiff < 24)
        return res
          .status(403)
          .json({ message: "Account is locked. Try again later." });

      user.isLocked = false; // Unlock account after 24 hours
      user.failedAttempts = 0;
      await user.save();
    }

    const isMatch = await bcrypt.compare(pin, user.pin);
    if (!isMatch) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= 3) {
        user.isLocked = true;
        user.lockTime = new Date();
        return res.status(403).json({ message: "Account locked for 24 hours" });
      }
      await user.save();
      const remainingAttempts = 3 - user.failedAttempts;
      return res.status(401).json({
        message: `Invalid PIN. ${remainingAttempts} attempts remaining.`,
      });
    }

    user.failedAttempts = 0;
    await user.save();

    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN,
      }
    );

    res.json({
      message: "Login successful",
      token,
      user,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Deposit
router.post("/deposit", authMiddleware, async (req, res) => {
  try {
    const { username, pin, amount } = req.body;
    const user = await User.findOne({ username });

    if (!user || user.isLocked)
      return res
        .status(403)
        .json({ message: "Account is locked or not found." });

    const isMatch = await bcrypt.compare(pin, user.pin);
    if (!isMatch) return res.status(400).json({ message: "Invalid PIN" });

    user.balance += Number(amount);
    user.transactions.push({
      type: "Deposit",
      amount: Number(amount),
      balanceAfterTransaction: user.balance,
    });

    await user.save();
    res.json({ message: "Deposit successful", balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Withdrawal
router.post("/withdraw", authMiddleware, async (req, res) => {
  try {
    const { username, pin, amount } = req.body;
    const user = await User.findOne({ username });

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isLocked)
      return res.status(403).json({ message: "Account is locked" });

    const isMatch = await bcrypt.compare(pin, user.pin);
    if (!isMatch) return res.status(400).json({ message: "Invalid PIN" });

    if (user.balance < amount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    user.balance -= amount;
    user.transactions.push({
      type: "Withdrawal",
      amount,
      balanceAfterTransaction: user.balance,
    });

    await user.save();
    res.json({ message: "Withdrawal successful", balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Internal Transfer
router.post("/transfer", authMiddleware, async (req, res) => {
  try {
    const { senderUsername, recipientAccountNumber, pin, amount } = req.body;

    const sender = await User.findOne({ username: senderUsername });
    const recipient = await User.findOne({
      accountNumber: recipientAccountNumber,
    });
    if (recipientAccountNumber === sender.accountNumber) {
      return res
        .status(400)
        .json({ message: "Cannot transfer to own Account" });
    }

    if (!sender) return res.status(404).json({ message: "Sender not found" });
    if (!recipient)
      return res.status(404).json({ message: "Recipient not found" });
    if (sender.isLocked)
      return res.status(403).json({ message: "Sender account is locked" });

    const receiverUser = await User.findOne({ username: recipient.username });
    if (!receiverUser) {
      return res.status(404).json({ message: "Recipient account not found" });
    }

    if (receiverUser.isLocked) {
      return res.status(403).json({
        message: "Recipient account is locked. Cannot transfer money.",
      });
    }
    const isMatch = await bcrypt.compare(pin, sender.pin);
    if (!isMatch) return res.status(400).json({ message: "Invalid PIN" });

    if (sender.balance < amount) {
      return res.status(400).json({ message: "Insufficient balance" });
    }

    // Deduct from sender
    sender.balance -= Number(amount);
    sender.transactions.push({
      type: "Transfer",
      amount,
      balanceAfterTransaction: sender.balance,
      details: { recipient: recipient.accountNumber },
    });

    // Add to recipient
    recipient.balance += Number(amount);
    recipient.transactions.push({
      type: "Transfer",
      amount,
      balanceAfterTransaction: recipient.balance,
      details: { sender: sender.accountNumber },
    });

    // Save both
    await sender.save();
    await recipient.save();

    res.json({ message: "Transfer successful", senderBalance: sender.balance });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Account Statement
router.get("/statement", authMiddleware, async (req, res) => {
  try {
    const { username } = req.user;

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({
      message: "Transaction history retrieved successfully",
      transactions: user.transactions,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/details", async (req, res) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token)
    return res
      .status(401)
      .json({ message: "Access denied. No token provided." });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log(decoded);
    const user = User.findById(decoded.id);
    res.send(user);
  } catch (err) {
    res.status(400).json({ message: "Invalid token." });
  }
});

module.exports = router;

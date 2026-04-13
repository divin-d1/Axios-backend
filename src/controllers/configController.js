/**
 * @desc    Get static form constants (Industries, Departments, Tech Stack)
 * @route   GET /api/config/constants
 */
exports.getConstants = (req, res) => {
  const constants = {
    industries: [
      "Technology & Software",
      "Financial Services",
      "Healthcare & Medical",
      "Education & EdTech",
      "E-commerce & Retail",
      "Manufacturing & Logistics",
      "Media & Entertainment",
      "Real Estate & Construction",
      "Government & Public Sector",
      "Energy & Utilities",
      "Consulting & Professional Services",
      "Non-Profit & NGO",
      "Other"
    ],
    departments: [
      "Engineering & Development",
      "Product & Design",
      "Data Science & AI",
      "Sales & Business Development",
      "Marketing & Communications",
      "Human Resources & Talent",
      "Finance & Accounting",
      "Operations & Supply Chain",
      "Customer Success & Support",
      "Legal & Compliance",
      "Executive & Management"
    ],
  };

  res.status(200).json(constants);
};

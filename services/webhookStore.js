'use strict';
// Mongoose-backed webhook store (production). Same interface as inMemoryStore.
function toObj(doc) { return doc ? doc.toObject({ versionKey: false }) : doc; }

function createMongooseStore(Model) {
  return {
    async create(data) { return toObj(await Model.create(data)); },
    async list() { return (await Model.find({})).map(toObj); },
    async update(id, data) { const d = await Model.findByIdAndUpdate(id, data, { new: true, runValidators: true }); return toObj(d); },
    async remove(id) { const d = await Model.findByIdAndDelete(id); return toObj(d); },
    async findById(id) { return toObj(await Model.findById(id)); },
    async findByEvent(event) { return (await Model.find({ active: true, events: event })).map(toObj); },
  };
}

module.exports = { createMongooseStore };
